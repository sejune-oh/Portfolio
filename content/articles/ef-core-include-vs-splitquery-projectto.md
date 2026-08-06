---
tags:
  - type/blog-post
  - status/needs-review
notion_title: "Include를 지웠더니 91초가 됐다 — ProjectTo 뒤에 숨은 AsSplitQuery"
notion_slug: ef-core-include-vs-splitquery-projectto
notion_date: 2026-08-06
notion_category: Backend
notion_tags: EF Core, AutoMapper, Performance, .NET
notion_summary: ProjectTo가 JOIN을 자동으로 만들어 주니 Include는 지워도 된다. 하지만 같이 지운 AsSplitQuery는 실행 전략이라 대체되지 않는다. 그 한 줄을 놓쳐 GET /hospitals가 0.04초에서 91초로 돌아간 이야기.
notion_published: false
source_notes:
  - knowledge/ef-core-include-split-query-with-projectto.md
source_hash: d773465f6ce0
generated_at: 2026-08-06T00:00:00Z
---

**`Include`는 지워도 됐지만, 같이 지운 `.AsSplitQuery()` 한 줄이 API를 0.04초에서 91초로 되돌렸다.** 둘 다 "관계를 가져오는 것"처럼 보이지만, 하나는 *무엇을* 가져올지의 지시이고 다른 하나는 *어떻게* 가져올지의 전략이다. 이 구분을 놓치면 SQL은 멀쩡히 실행되는데 요청은 타임아웃한다.

## 세 개념의 역할부터 분리한다

- **`Include`** — "이 관계를 eager-loading 해라." *무엇을* 가져올지의 지시.
- **`AsSplitQuery`** — "그 로딩을 하나의 SQL 대신 여러 SQL로 쪼개라." *어떻게* 실행할지의 전략.
- **`ProjectTo<T>`** — AutoMapper 설정을 `Expression<Func<TSource, TDest>>`로 조립해 EF Core에 넘긴다. 그 과정에서 **필요한 JOIN을 자동으로 생성**한다.

여기서 흔한 오해가 나온다. `ProjectTo`가 JOIN을 자동으로 만들어 주니 `Include`는 대부분 중복이다. 실제로 `Include`를 지워도 EF Core가 만드는 SQL은 동일하고, 결과도 byte-for-byte 같다(응답 페이로드 MD5로 확인했다). **그래서 "`Include`가 중복이면 `AsSplitQuery`도 필요 없겠지"라고 넘겨짚는 순간 사고가 난다.** `AsSplitQuery`는 실행 전략이라 `ProjectTo`가 대체해 주지 않는다.

## Cartesian explosion — 곱셈으로 터진다

독립적인 1:N 컬렉션 여러 개를 하나의 쿼리(SingleQuery)로 묶으면 행 수가 더해지는 게 아니라 **곱해진다.**

```
병원 20건 × Translations 10개 × Specialties 5개 × Medias 4개 × ...
  → 실측 138,523,392 rows (1.38억)
```

SQL은 실행된다. 문제는 그 1.38억 행을 TDS로 전송하고 EF Core가 메모리에서 부모 객체로 재조립하는 단계가 포화된다는 것이다. EF Core는 이 패턴을 미리 경고까지 해 준다.

```
warn: Microsoft.EntityFrameworkCore.Query[20504]
      Compiling a query which loads related collections for more than one
      collection navigation ... 'SingleQuery' ... can potentially result in
      slow query performance.
```

`.AsSplitQuery()`를 붙이면 EF Core가 컬렉션별로 독립 쿼리를 발행한다.

```
SQL 1: SELECT * FROM Hospitals WHERE ...                             → 20 rows
SQL 2: SELECT * FROM HospitalTranslations WHERE HospitalId IN (...)  → 200 rows
SQL 3: SELECT * FROM HospitalSpecialties  WHERE HospitalId IN (...)  → 100 rows
```

행 수가 곱셈에서 덧셈으로 바뀐다(1.38억 → 수천, 약 10만 배 감소). 대가는 DB 왕복이 1회에서 N회로 느는 것뿐이다.

## 실수와 올바른 패턴

리팩터링 중 "`Include`도 `AsSplitQuery`도 필요 없어 보인다"며 둘 다 지운 코드가 이렇다.

```csharp
// ❌ AsSplitQuery까지 지워 SingleQuery 기본값으로 되돌아감
_context.Hospitals
    .AsNoTracking()
    .ProjectTo<HospitalItemModel>(_mapper.ConfigurationProvider)
    .ToList();
```

결과는 timeout이었다. 올바른 형태는 `Include`는 지우되(`ProjectTo`가 대체하므로), `AsSplitQuery`는 **주석과 함께** 남기는 것이다.

```csharp
_context.Hospitals
    // Required: many-collection projection causes single-query cartesian
    // explosion without split. #11165
    .AsSplitQuery()
    .AsNoTracking()
    .OrderBy(x => x.AuditableEntity.CreatedDate).ThenBy(x => x.Id)
    .ProjectTo<HospitalItemModel>(_mapper.ConfigurationProvider)
    .ToList();
```

주석 한 줄이 중요하다. 이유가 적혀 있지 않으면 다음 사람이 또 "중복 같다"며 지운다.

## 판단 기준

| Projection 성격 | Include | AsSplitQuery |
|---|---|---|
| 엔티티 그대로 로드 (`_mapper.Map<T>(entity)`) | ✅ 필수 | 깊은 컬렉션이면 권장 |
| `ProjectTo<T>` + 얕은 matrix (1~2 컬렉션) | ❌ 중복 | 보통 불필요 |
| `ProjectTo<T>` + 깊은 matrix (3+ sibling 1:N) | ❌ 중복 | ✅ 필수 — 생략 시 explosion |

한 가지 예외는 기억해 둘 만하다. `ProjectTo`가 아니라 엔티티를 메모리에 올려 `_mapper.Map<>`으로 매핑하는 경로에서는 `Include`가 여전히 필수다. 이때는 매핑이 SQL에 관여하지 않으므로, `Include` 없이는 `hospital.Country`가 그냥 `null`이다.

## 남는 것

`Include`와 `AsSplitQuery`는 이름이 비슷해서 한 덩어리로 취급하기 쉽지만, 하나는 *무엇을*의 문제이고 하나는 *어떻게*의 문제다. `ProjectTo`는 앞의 것만 대체한다. 깊은 다중 컬렉션 projection에서 `.AsSplitQuery()` 한 줄은 선택이 아니라 필수이고, 지울 거라면 그 이유를 코드가 아니라 주석에 남겨 둬야 다음 사고를 막는다.
