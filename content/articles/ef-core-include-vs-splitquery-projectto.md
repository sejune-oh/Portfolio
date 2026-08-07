---
tags:
  - type/blog-post
  - status/ready-to-publish
notion_title: "Include는 지워도 되지만 AsSplitQuery는 아니다"
notion_slug: ef-core-include-vs-splitquery-projectto
notion_date: 2026-08-06
notion_category: Backend
notion_tags: EF Core, AutoMapper, Performance, .NET
notion_summary: ProjectTo가 JOIN을 자동으로 만들어 주니 Include는 지워도 된다. 하지만 함께 지운 AsSplitQuery는 실행 전략이라 대체되지 않는다. 그 한 줄을 놓쳐 GET /hospitals 응답이 0.04초에서 91초로 돌아간 이야기.
notion_published: true
source_notes:
  - knowledge/ef-core-include-split-query-with-projectto.md
source_hash: d773465f6ce0
generated_at: 2026-08-06T00:00:00Z
---

**`Include`를 지운 건 옳았다. 함께 지운 `.AsSplitQuery()`가 문제였다.** 그 한 줄 때문에 GET /hospitals 응답이 0.04초에서 91초로 돌아갔다.

## 비슷해 보이는 세 가지

셋은 이름이 붙어 다니지만 하는 일이 다르다.

- `Include`는 "이 관계를 eager-loading 해라"는 지시다. 무엇을 가져올지의 문제다.
- `AsSplitQuery`는 "그 로딩을 하나의 SQL 대신 여러 SQL로 쪼개라"는 실행 전략이다. 어떻게 가져올지의 문제다.
- `ProjectTo<T>`는 AutoMapper 설정을 `Expression<Func<TSource, TDest>>`로 조립해 EF Core에 넘긴다. 그 과정에서 필요한 JOIN을 자동으로 만든다.

여기서 흔한 오해가 나온다. `ProjectTo`가 JOIN을 자동으로 만들어 주니 `Include`는 대부분 중복이다. 실제로 `Include`를 지워도 EF Core가 만드는 SQL은 같고 결과도 동일하다. 응답 페이로드를 MD5로 비교해 byte-for-byte 일치하는 것까지 확인했다.

문제는 그다음이다. "`Include`가 중복이면 `AsSplitQuery`도 필요 없겠지"라고 넘겨짚는 순간 사고가 난다. `AsSplitQuery`는 실행 전략이라 `ProjectTo`가 대체하지 않는다.

## 곱셈으로 터지는 행

독립적인 1:N 컬렉션 여러 개를 하나의 쿼리로 묶으면 행 수가 더해지지 않고 곱해진다.

```
병원 20건 × Translations 10개 × Specialties 5개 × Medias 4개 × ...
  = 실측 138,523,392 rows (1.38억)
```

SQL 자체는 실행된다. 포화되는 건 그 1.38억 행을 TDS로 전송하고 EF Core가 메모리에서 부모 객체로 재조립하는 단계다. 여기서 타임아웃이 난다. EF Core는 이 패턴을 컴파일 시점에 경고까지 해 준다.

```
warn: Microsoft.EntityFrameworkCore.Query[20504]
      Compiling a query which loads related collections for more than one
      collection navigation ... 'SingleQuery' ... can potentially result in
      slow query performance.
```

`.AsSplitQuery()`를 붙이면 EF Core가 컬렉션별로 독립 쿼리를 발행한다.

```
SQL 1: SELECT * FROM Hospitals WHERE ...                             = 20 rows
SQL 2: SELECT * FROM HospitalTranslations WHERE HospitalId IN (...)  = 200 rows
SQL 3: SELECT * FROM HospitalSpecialties  WHERE HospitalId IN (...)  = 100 rows
```

행 수가 곱셈에서 덧셈으로 바뀐다. 1.38억이 수천으로 줄어든다. 대가는 DB 왕복이 1회에서 N회로 느는 것뿐이다.

## 실수와 올바른 패턴

리팩터링 중 "`Include`도 `AsSplitQuery`도 필요 없어 보인다"며 둘 다 지운 코드가 이랬다.

```csharp
// AsSplitQuery까지 지워 SingleQuery 기본값으로 되돌아감
_context.Hospitals
    .AsNoTracking()
    .ProjectTo<HospitalItemModel>(_mapper.ConfigurationProvider)
    .ToList();
```

결과는 타임아웃이었다. 올바른 형태는 `Include`는 지우되(`ProjectTo`가 대체하므로) `AsSplitQuery`는 주석과 함께 남기는 것이다.

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

주석 한 줄이 중요하다. 이유가 적혀 있지 않으면 다음 사람이 또 중복 같다며 지운다.

## 판단 기준

| Projection 성격 | Include | AsSplitQuery |
|---|---|---|
| 엔티티 그대로 로드 (`_mapper.Map<T>(entity)`) | 필수 | 깊은 컬렉션이면 권장 |
| `ProjectTo<T>` + 얕은 matrix (1~2 컬렉션) | 중복 | 보통 불필요 |
| `ProjectTo<T>` + 깊은 matrix (3+ sibling 1:N) | 중복 | 필수 (생략 시 explosion) |

예외 하나는 기억해 둘 만하다. `ProjectTo`가 아니라 엔티티를 메모리에 올려 `_mapper.Map<>`으로 매핑하는 경로에서는 `Include`가 여전히 필수다. 이때는 매핑이 SQL에 관여하지 않으므로 `Include` 없이는 `hospital.Country`가 그냥 null이 된다.

## 남는 것

`Include`와 `AsSplitQuery`는 이름이 붙어 다녀서 한 덩어리로 취급하기 쉽다. 하지만 하나는 무엇을의 문제이고 하나는 어떻게의 문제이며, `ProjectTo`는 앞의 것만 대체한다. 깊은 다중 컬렉션 projection에서 `.AsSplitQuery()` 한 줄은 선택이 아니라 필수다. 지울 거라면 그 이유를 주석에 남겨 다음 사고를 막아야 한다.

## 참고

- [EF Core: Single vs. split queries](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries)
- [EF Core: Related data and serialization](https://learn.microsoft.com/en-us/ef/core/querying/related-data)
- [AutoMapper: Queryable Extensions (ProjectTo)](https://docs.automapper.org/en/latest/Queryable-Extensions.html)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
