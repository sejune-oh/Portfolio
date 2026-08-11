---
tags:
  - type/blog-post
  - status/ready-to-publish
notion_title: "트랜잭션 밖 FK 사전 체크 안티패턴"
notion_slug: pre-transaction-fk-check-anti-pattern
notion_date: 2026-08-07
notion_category: Backend
notion_tags: EF Core, Database, Concurrency, .NET
notion_summary: 트랜잭션 시작 전에 SELECT로 부모 존재를 확인하는 패턴은 TOCTOU race를 못 막으면서 왕복 쿼리만 늘린다. 결국 DB의 FK 제약이 최종 가드라는 점과, 제거·예외 분기 등 현실적 대안.
notion_published: true
source_notes:
  - knowledge/check-fk-anti-pattern.md
source_hash: 1ac5d0f79707
generated_at: 2026-08-07T00:00:00Z
---

배치로 데이터를 옮기다 보면 이런 코드를 자주 만난다. 자식을 넣기 전에 부모가 있는지 먼저 확인하고, 없으면 예외를 던진다. 안전해 보인다. 그런데 이 확인은 정작 막아야 할 것을 못 막으면서 쿼리만 하나 더 쓴다.

이유는 확인하는 순간과 실제로 쓰는 순간 사이에 틈이 있기 때문이다. 그 틈에서 부모가 사라지면, 미리 확인했든 아니든 INSERT는 FK 위반으로 실패한다.

## 확인과 사용 사이의 틈

전형적인 형태는 이렇다. 트랜잭션 밖에서 `AnyAsync`로 부모가 있는지 보고, 그다음 트랜잭션을 열어 자식을 INSERT한다.

```csharp
if (!await ctx.Hospitals.AnyAsync(h => h.Id == parentId, ct))
    throw new InvalidOperationException("Parent not found");

using var tx = await ctx.Database.BeginTransactionAsync(ct);
ctx.Articles.Add(new Article { HospitalId = parentId });
await ctx.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

시간 순으로 따라가 보면 구멍이 드러난다.

| 시점 | 동작 |
|---|---|
| t0 | `AnyAsync(Id == parentId)`가 존재로 통과 |
| t1 | 다른 세션이 그 부모를 DELETE |
| t2 | 트랜잭션 시작 |
| t3 | INSERT가 FK 위반 (SQL Server 547) |

t0에서 확인은 성공했지만 t1에서 상황이 바뀐다. 이게 TOCTOU(Time-Of-Check / Time-Of-Use) race다. 선행 체크가 있어도 race는 그대로 나고, 결국 막는 것은 DB의 FK 제약이다. 그러면 앞의 SELECT는 무엇을 한 걸까. 왕복 한 번을 더 쓴 것 말고는 없다.

## 무해해 보이지만 값을 치른다

이 패턴이 조용히 비용을 만드는 지점이 세 곳이다.

먼저 성능이다. 레코드마다 부모 수만큼 사전 SELECT가 붙는다. 한두 건이면 티가 안 나지만 배치 sync나 bulk import에서는 이 왕복이 쌓인다.

다음은 거짓 안전감이다. "미리 확인했으니 괜찮다"고 여기면 정작 race로 `DbUpdateException`이 났을 때 분기나 재시도를 안 만들어 둔다. 그 결과 레코드 하나 때문에 배치 전체가 멈추는 과잉 반응으로 이어진다.

마지막은 코드 중복이다. DB가 이미 정의한 제약을 애플리케이션에서 한 번 더 구현하는 셈이라, cascade나 soft delete를 도입하는 순간 둘이 어긋난다.

## 그래도 선행 체크가 쓸모 있을 때

물론 항상 지워야 하는 건 아니다. 유저 친화적 에러가 필요한 공개 API라면 "해당 병원이 없습니다"를 422로 내려 주는 편이 낫다. 단 이때도 race로 예외가 날 수 있으니 try/catch를 함께 둔다.

실제 쓰기 없이 정합성만 보고하는 dry-run 검증도 선행 체크가 자연스럽다. FK가 없을 때 뒤따르는 외부 호출이나 큰 파일 I/O를 건너뛰려는 best-effort skip도 마찬가지다. race-free는 아니어도 비용을 아끼는 값은 한다.

## 셋 중 하나를 고른다

상황이 정리되면 대응은 세 갈래다.

동시 쓰기가 없는 유지보수 창 전용 도구라면, 코드를 손대는 대신 "no concurrent writers" 전제를 문서에 박아 두는 게 제일 실용적이다.

그게 아니면 선행 체크를 지운다. FK 위반이 나면 `DbUpdateException.InnerException`에 위반한 컬럼이 담겨 오니 그걸로 충분하다.

레코드 단위로 살리고 싶다면 예외를 직접 다룬다.

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

한 가지 더. 격리 수준을 올려도 트랜잭션 밖의 SELECT는 보호받지 못한다. 선행 체크를 트랜잭션 안으로 옮겨도 `SERIALIZABLE`에 `HOLDLOCK`까지 가야 완전히 막히는데, 거기까지 필요하면 애초에 DB FK와 예외 분기가 더 단순하고 안전하다.

## 지금 확인해 볼 것

지금 배치나 sync 코드에 트랜잭션 밖 존재 확인이 있다면, 그 뒤에 `DbUpdateException` 분기가 있는지부터 보자. 없다면 둘 중 하나다. 선행 체크를 지우고 FK에 맡기거나, race를 실제로 처리하는 catch를 넣거나.

## 참고

- [Microsoft Learn: Using transactions (EF Core)](https://learn.microsoft.com/en-us/ef/core/saving/transactions)
- SQL Server error 547: INSERT statement conflicted with the FOREIGN KEY constraint

이 글은 AI가 사실을 기반으로 작성한 글입니다.
