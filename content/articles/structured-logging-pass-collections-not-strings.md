---
tags:
  - type/blog-post
  - status/ready-to-publish
notion_title: "구조화 로깅과 컬렉션 직렬화"
notion_slug: structured-logging-pass-collections-not-strings
notion_date: 2026-08-07
notion_category: Observability
notion_tags: Logging, Observability, .NET, Serilog
notion_summary: ILogger 구조화 로깅에 컬렉션을 string.Join으로 미리 합쳐 넘기면 필드별 검색·필터라는 이점이 사라지고 로그가 비대해진다. 원본 컬렉션을 그대로 넘기고 포맷은 수집기에 맡겨야 하는 이유와 올바른 패턴.
notion_published: true
source_notes:
  - knowledge/structured-logging-컬렉션을-string-join으로-합치지-말기.md
source_hash: 095b6662afbd
generated_at: 2026-08-07T00:00:00Z
---

로그 수집기에서 특정 ID로 검색했는데 아무것도 안 잡힌다. 로그 라인에는 분명히 그 ID가 찍혀 있는데도 그렇다. 십중팔구 컬렉션을 `string.Join`으로 미리 합쳐서 넘겼기 때문이다.

`ILogger`의 구조화 로깅에 컬렉션을 넘길 때, 호출하는 쪽에서 문자열로 만들어 넘기면 구조화 로깅의 이점이 그 순간 사라진다. 원본 컬렉션을 그대로 넘기고 포맷은 수집기(sink)에 맡기는 게 원칙이다.

## 무엇을 잃는가

`string.Join`으로 합쳐 넘기면 네 가지를 잃는다.

검색과 필터를 잃는다. `ContactIds`가 통짜 문자열로 남으면 ID 하나로 로그를 쿼리할 수 없다. 배열로 남겼다면 Seq나 Elastic, App Insights에서 `ContactIds CONTAINS "abc"`처럼 찾을 수 있다.

크기도 잃는다. GUID 하나가 36자다. 100개를 합치면 한 줄이 약 4KB로 불어난다. App Insights처럼 용량으로 과금하는 곳이면 이게 바로 비용이다.

효율도 손해다. `string.Join`은 로그 레벨 필터링보다 먼저 실행된다. `LogDebug`가 꺼져 있어도 문자열을 만드는 일은 그대로 한다.

마지막으로 형식을 잃는다. 컬렉션은 배열로 기록돼야 나중에 구조화 분석이 되는데, 합쳐 버리면 그냥 스칼라 문자열이다.

## 원본을 넘기고 포맷은 sink에게

Serilog 관례에서는 placeholder 앞 기호가 캡처 방식을 정한다. `{Name}`은 스칼라 캡처(ToString), `{@Name}`은 객체나 컬렉션을 destructure, `{$Name}`은 강제로 문자열화한다.

```csharp
// 안티패턴
logger.LogInformation(
    "Fetching Contacts {ContactIds} for Tenant {TenantId}",
    string.Join(", ", requestedContactIds), tenantId);

// 올바른 패턴: 컬렉션은 그대로, count는 따로
logger.LogInformation(
    "Fetching {ContactCount} Contacts for Tenant {TenantId}: {@ContactIds}",
    requestedContactIds.Count, tenantId, requestedContactIds);
```

뒤 형태는 `ContactIds`가 JSON 배열로 남아 개별 ID로 검색된다. 각 ID가 굳이 필요 없는 대량 호출이면 count만 남기고, 원본이 필요하면 `LogDebug`로 따로 빼는 편이 깔끔하다.

## 밟기 쉬운 지점들

몇 가지는 미리 알아두면 헷갈리지 않는다.

순정 `Microsoft.Extensions.Logging`에서는 `{@Name}`의 `@`가 리터럴로 처리될 수 있다. destructure로 동작하려면 Serilog 같은 구현이 아래에 깔려 있어야 한다.

`{@Entity}`로 엔티티 전체를 찍는 것도 조심한다. navigation property까지 lazy load되면서 N+1 쿼리와 로그 비대화를 동시에 부른다. 필요한 필드만 익명 객체로 뽑아 넘긴다.

placeholder가 named여도 인자 순서는 맞춰야 한다. 순서가 어긋나면 컴파일 에러 없이 값이 엉뚱한 필드에 들어간다.

`{@User}`로 password나 token이 새지 않게 민감 필드는 마스킹한다. secret, token, password 류에 표시를 붙이는 관례를 팀에 두면 실수를 줄인다.

destructure 자체는 레벨이 켜져야 실행되지만, `JsonSerializer.Serialize(obj)`처럼 인자를 미리 계산하는 코드는 레벨과 무관하게 돈다. 비싸면 `logger.IsEnabled(LogLevel.Debug)`로 감싼다.

## 지금 확인해 볼 것

코드에서 `string.Join`이 들어간 로그 호출을 검색해 보자. 컬렉션을 합쳐 넘기는 자리가 있으면 원본을 그대로 넘기도록 바꾸고, 각 항목이 필요 없으면 count만 남기면 된다.

## 참고

- [Serilog: Writing Log Events](https://github.com/serilog/serilog/wiki/Writing-Log-Events)
- [Microsoft Learn: Logging in .NET (message template)](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
