---
tags:
  - type/blog-post
  - status/needs-review
notion_title: "구조화 로깅과 컬렉션 로깅"
notion_slug: structured-logging-pass-collections-not-strings
notion_date: 2026-08-07
notion_category: Observability
notion_tags: Logging, Observability, .NET, Serilog
notion_summary: ILogger 구조화 로깅에 컬렉션을 string.Join으로 미리 합쳐 넘기면 필드별 검색·필터라는 이점이 사라지고 로그가 비대해진다. 원본 컬렉션을 그대로 넘기고 포맷은 수집기에 맡겨야 하는 이유와 올바른 패턴.
notion_published: false
source_notes:
  - knowledge/structured-logging-컬렉션을-string-join으로-합치지-말기.md
source_hash: 095b6662afbd
generated_at: 2026-08-07T00:00:00Z
---

**로그에 컬렉션을 `string.Join`으로 합쳐 넘기는 순간, 구조화 로깅은 그냥 긴 문자열 로깅으로 되돌아간다.** 원본 컬렉션을 그대로 넘기고 포맷은 수집기(sink)에게 맡기는 것이 원칙이다.

## 무엇을 잃는가

`logger.LogInformation("Fetching Contacts {ContactIds} ...", string.Join(", ", ids), tenantId)`처럼 쓰면 네 가지를 잃는다.

검색과 필터를 잃는다. `ContactIds`가 통짜 문자열이라 ID 하나로 로그를 쿼리할 수 없다. 배열로 남기면 Seq, Elastic, App Insights에서 `ContactIds CONTAINS "abc"` 같은 쿼리가 된다.

크기를 잃는다. GUID 하나가 36자다. 100개면 한 줄이 약 4KB로 불어난다. App Insights처럼 용량 기반 과금이면 그대로 비용이다.

효율을 잃는다. `string.Join`은 로그 레벨 필터링보다 먼저 실행된다. `LogDebug`가 꺼져 있어도 문자열 조합은 수행된다.

형식을 잃는다. 컬렉션은 배열로 기록돼야 구조화 분석이 되는데, 합치면 스칼라 문자열이 된다.

## 원칙: 원본을 넘기고 포맷은 sink에게

Serilog 관례에서는 placeholder 앞 기호가 캡처 방식을 정한다. `{Name}`은 스칼라 캡처(ToString), `{@Name}`은 구조화 캡처(객체·컬렉션을 destructure), `{$Name}`은 강제 문자열화다.

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

뒤 형태는 `ContactIds`가 JSON 배열로 남아 개별 ID로 쿼리된다. 각 ID가 중요하지 않은 대량 호출이면 count만 남기고, 원본이 필요하면 `LogDebug`로 분리한다.

## 자주 밟는 지뢰

순정 `Microsoft.Extensions.Logging`에서는 `{@Name}`의 `@`가 리터럴로 처리될 수 있다. destructure로 동작하려면 Serilog 같은 구현이 아래에 깔려 있어야 한다.

`{@Entity}`로 엔티티 전체를 찍으면 navigation property까지 lazy load되어 N+1 쿼리와 로그 비대화를 부른다. 필요한 필드만 익명 객체로 뽑아 넘긴다.

named placeholder라도 인자 순서를 맞춰야 한다. 순서가 엇갈리면 컴파일 에러 없이 필드가 잘못 매칭된다.

`{@User}`로 password나 token이 새지 않도록 마스킹한다. secret, token, password 류 필드에 표시를 붙이는 관례를 둔다.

destructure 자체는 레벨이 켜져야 실행되지만, `JsonSerializer.Serialize(obj)`처럼 인자를 미리 계산하는 코드는 그대로 실행된다. 비싸면 `logger.IsEnabled(LogLevel.Debug)`로 가드한다.

## 참고

- [Serilog: Writing Log Events](https://github.com/serilog/serilog/wiki/Writing-Log-Events)
- [Microsoft Learn: Logging in .NET (message template)](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
