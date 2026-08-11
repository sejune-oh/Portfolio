---
tags:
  - type/blog-post
  - status/ready-to-publish
notion_title: "EF Core: Include·AsSplitQuery·ProjectTo"
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

리팩터링을 하다 보면 "이 줄, 없어도 되지 않나?" 싶은 코드가 눈에 띈다. `GET /hospitals`에서 `Include`와 `.AsSplitQuery()`가 그랬다. `ProjectTo`를 쓰고 있으니 둘 다 군더더기처럼 보였고, 그래서 지웠다. 응답 시간이 0.04초에서 91초로 뛰었다.

문제는 둘을 한 덩어리로 본 것이었다. `Include`는 지워도 됐지만 `.AsSplitQuery()`는 아니었다. 이름이 붙어 다녀서 비슷해 보일 뿐, 하나는 무엇을 가져오나의 문제이고 다른 하나는 어떻게 가져오나의 문제다.

## 세 가지가 각각 하는 일

먼저 셋을 떼어놓고 보자. `Include`는 "이 관계를 eager-loading 해라"라는 지시다. 무엇을 가져올지를 정한다. `AsSplitQuery`는 "그 로딩을 하나의 SQL 대신 여러 SQL로 쪼개라"라는 실행 전략이다. 어떻게 가져올지를 정한다. `ProjectTo<T>`는 AutoMapper 설정을 `Expression<Func<TSource, TDest>>`로 조립해 EF Core에 넘기는데, 이 과정에서 필요한 JOIN을 알아서 만든다.

여기서 오해가 시작된다. `ProjectTo`가 JOIN을 자동으로 만들어 주니 `Include`는 대부분 중복이다. 실제로 `Include`를 지워도 EF Core가 만드는 SQL은 같고 결과도 같다. 응답 페이로드를 MD5로 비교해 한 바이트도 다르지 않은 것까지 확인했다. 그러니 "`Include`가 중복이면 `AsSplitQuery`도 필요 없겠지"로 넘어가기 쉽다. 그런데 `AsSplitQuery`는 실행 전략이라 `ProjectTo`가 대신 해주지 않는다.

## 행이 곱으로 불어난다

왜 그 한 줄이 91초를 만들었는지는 행 수를 따라가 보면 보인다. 독립적인 1:N 컬렉션 여러 개를 하나의 쿼리로 묶으면, 행은 더해지는 게 아니라 곱해진다.

```
병원 20건 × Translations 10개 × Specialties 5개 × Medias 4개 × ...
  = 실측 138,523,392 rows (1.38억)
```

SQL 자체는 돈다. 버티지 못하는 건 그 1.38억 행을 TDS로 실어 나르고 EF Core가 메모리에서 부모 객체로 다시 조립하는 단계다. 여기서 타임아웃이 난다. EF Core도 이걸 알고 컴파일 시점에 경고를 띄운다.

```
warn: Microsoft.EntityFrameworkCore.Query[20504]
      Compiling a query which loads related collections for more than one
      collection navigation ... 'SingleQuery' ... can potentially result in
      slow query performance.
```

`.AsSplitQuery()`를 붙이면 EF Core가 컬렉션마다 독립 쿼리를 따로 발행한다.

```
SQL 1: SELECT * FROM Hospitals WHERE ...                             = 20 rows
SQL 2: SELECT * FROM HospitalTranslations WHERE HospitalId IN (...)  = 200 rows
SQL 3: SELECT * FROM HospitalSpecialties  WHERE HospitalId IN (...)  = 100 rows
```

곱이 합으로 바뀌면서 1.38억이 수천으로 준다. 대가는 DB 왕복이 한 번에서 몇 번으로 느는 것뿐인데, 카테시안 폭발에 비하면 감당할 만하다.

## 그래서 어떻게 쓰나

정리하면 이렇다. `Include`는 `ProjectTo`가 대신하니 지워도 된다. `.AsSplitQuery()`는 남긴다. 대신 왜 남기는지 주석으로 이유를 붙여 둔다. 이유가 없으면 다음 사람이 또 "중복 같은데" 하고 지운다.

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

언제 무엇이 필요한지는 projection 성격으로 갈린다.

| Projection 성격 | Include | AsSplitQuery |
|---|---|---|
| 엔티티 그대로 로드 (`_mapper.Map<T>(entity)`) | 필수 | 깊은 컬렉션이면 권장 |
| `ProjectTo<T>` + 얕은 matrix (1~2 컬렉션) | 중복 | 보통 불필요 |
| `ProjectTo<T>` + 깊은 matrix (3+ sibling 1:N) | 중복 | 필수 (생략 시 explosion) |

예외 하나는 기억해 둘 만하다. `ProjectTo`가 아니라 엔티티를 메모리에 올려 `_mapper.Map<>`으로 매핑하는 경로에서는 `Include`가 여전히 필수다. 이때는 매핑이 SQL에 관여하지 않으니, `Include` 없이는 `hospital.Country`가 그냥 null이 된다.

## 지금 확인해 볼 것

지금 다루는 코드에 `ProjectTo`와 깊은 다중 컬렉션이 함께 있다면, 쿼리에 `.AsSplitQuery()`가 붙어 있는지부터 확인하자. 없으면 붙이고, 붙일 때는 왜 필요한지 주석을 함께 남겨 다음 사람이 지우지 않게 한다.

## 참고

- [EF Core: Single vs. split queries](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries)
- [EF Core: Related data and serialization](https://learn.microsoft.com/en-us/ef/core/querying/related-data)
- [AutoMapper: Queryable Extensions (ProjectTo)](https://docs.automapper.org/en/latest/Queryable-Extensions.html)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
