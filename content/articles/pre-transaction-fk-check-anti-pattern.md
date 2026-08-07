---
tags:
  - type/blog-post
  - status/needs-review
notion_title: "트랜잭션 밖 FK 존재 확인은 race도 못 막고 왕복만 늘린다"
notion_slug: pre-transaction-fk-check-anti-pattern
notion_date: 2026-08-07
notion_category: Backend
notion_tags: EF Core, Database, Concurrency, .NET
notion_summary: 트랜잭션 시작 전에 SELECT로 부모 존재를 확인하는 패턴은 TOCTOU race를 못 막으면서 왕복 쿼리만 늘린다. 결국 DB의 FK 제약이 최종 가드라는 점과, 제거·예외 분기 등 현실적 대안.
notion_published: false
source_notes:
  - knowledge/check-fk-anti-pattern.md
source_hash: 1ac5d0f79707
generated_at: 2026-08-07T00:00:00Z
---

**트랜잭션을 시작하기 전에 부모가 있는지 `SELECT`로 확인하는 코드는, 정작 경쟁 상태(race)를 막지 못하면서 왕복 쿼리만 늘린다.** DB의 FK 제약이 어차피 최종 가드이기 때문이다.

## 확인과 사용 사이의 틈

전형적인 형태는 이렇다. 트랜잭션 밖에서 `AnyAsync`로 부모 존재를 확인하고, 그다음 트랜잭션을 열어 자식을 INSERT한다.

```csharp
if (!await ctx.Hospitals.AnyAsync(h => h.Id == parentId, ct))
    throw new InvalidOperationException("Parent not found");

using var tx = await ctx.Database.BeginTransactionAsync(ct);
ctx.Articles.Add(new Article { HospitalId = parentId });
await ctx.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

문제는 확인 시점과 사용 시점 사이에 틈이 있다는 것이다.

| 시점 | 동작 |
|---|---|
| t0 | `AnyAsync(Id == parentId)`가 존재로 통과 |
| t1 | 다른 세션이 그 부모를 DELETE |
| t2 | 트랜잭션 시작 |
| t3 | INSERT가 FK 위반 (SQL Server 547) |

선행 체크가 있었어도 race는 그대로 난다. 결국 막는 것은 DB의 FK 제약이고, 선행 SELECT는 불필요한 round-trip이 된다.

## 무해해 보이지만 해로운 이유

성능을 깎는다. 레코드마다 부모 수만큼 사전 SELECT가 붙는다. 배치 sync나 bulk import에서 이 지연이 누적된다.

거짓 안전감을 준다. "미리 확인했다"는 착각 탓에, race로 `DbUpdateException`이 났을 때 분기나 재시도가 없어 배치 전체를 중단하는 과잉 반응으로 이어지기 쉽다.

코드를 중복시킨다. DB가 정의한 제약을 애플리케이션에서 한 번 더 구현하는 셈이라, cascade나 soft delete 도입 같은 제약 변경 때 서로 어긋난다.

## 그래도 선행 체크가 의미 있는 경우

유저 친화적 에러가 필요한 공개 API가 그렇다. "해당 병원이 없습니다"를 422로 내리고 싶을 때다. 단 이때도 race로 예외가 날 수 있으니 try/catch를 반드시 병행한다.

실제 쓰기 없이 정합성 리포트만 내는 dry-run 사전 검증도 해당한다. FK가 없으면 외부 호출이나 대용량 I/O를 건너뛰고 싶은 best-effort skip도 마찬가지다. race-free는 아니지만 뒤따르는 비용을 아낀다.

## 현실적인 세 가지 선택

첫째, 문서 전제다. 동시 쓰기가 없는 유지보수 창 전용 도구라면, 코드 대신 "no concurrent writers" 전제를 문서에 박는다.

둘째, 제거다. 선행 체크를 지운다. FK 위반 시 `DbUpdateException.InnerException`에 위반 컬럼이 담겨 온다.

셋째, 예외 분기다. race를 실제로 다룬다.

```csharp
catch (DbUpdateException ex) when (IsFkViolation(ex))
{
    await tx.RollbackAsync(ct);
    logger.LogWarning("FK race on #{Id}; skipping", legacy.Id);
    return; // 다음 레코드로 진행. 배치 전체 중단 방지
}

static bool IsFkViolation(DbUpdateException ex) =>
    ex.InnerException is SqlException sql && sql.Number == 547;
```

## 기억할 점

격리 수준을 올려도 트랜잭션 밖의 SELECT는 보호받지 못한다. 선행 체크를 트랜잭션 안으로 옮겨도 `SERIALIZABLE`에 `HOLDLOCK`까지 가야 완전히 막히는데, 그 수준이 필요하면 애초에 DB FK와 예외 분기가 더 단순하고 안전하다.

제네릭 선행 체크가 PK 이름을 "Id"로 가정하면 복합 키나 shadow key 엔티티에서 런타임에 깨진다.

## 참고

- [Microsoft Learn: Using transactions (EF Core)](https://learn.microsoft.com/en-us/ef/core/saving/transactions)
- SQL Server error 547: INSERT statement conflicted with the FOREIGN KEY constraint

이 글은 AI가 사실을 기반으로 작성한 글입니다.
