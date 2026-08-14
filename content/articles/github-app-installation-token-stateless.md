---
tags:
  - type/blog-post
  - status/needs-review
notion_title: "GitHub App 설치 토큰 Stateless 전환 대응"
notion_slug: github-app-installation-token-stateless
notion_date: 2026-08-14
notion_category: Backend
notion_tags: GitHub, GitHub App, Authentication, .NET
notion_summary: GitHub App 설치 토큰이 ghs_ prefix는 유지한 채 JWT 형태·약 520자로 길어지는 Stateless 형식으로 바뀐다. 길이·정규식·DB 컬럼 가정을 걷어내고 opaque 액세스 토큰으로 취급하는 법과, override 헤더로 미리 테스트하는 절차.
notion_published: false
source_notes:
  - knowledge/github-new-installation-token-type.md
source_hash: c0549b91d911
generated_at: 2026-08-14T00:00:00Z
---

GitHub App으로 API를 호출하던 코드가 어느 날 갑자기 토큰을 거부한다. 토큰은 분명히 발급됐는데 앱 안에서 "Invalid GitHub token"으로 튕긴다. 원인은 대개 우리 코드가 그 토큰을 특정 길이나 형식으로 가정하고 있었기 때문이다.

GitHub가 GitHub App 설치 토큰(Installation Access Token)의 형식을 바꾸고 있다. 2026년 4월부터 새 Stateless 형식이 단계적으로 롤아웃됐고, 5월 15일부터는 앱이 미리 테스트할 수 있는 per-request override 헤더가 제공된다. 대응의 핵심은 한 문장으로 줄어든다. 설치 토큰을 내부 구조가 있는 무언가로 보지 말고, 불투명한(opaque) 액세스 토큰으로 취급하면 된다.

## 무엇이 바뀌나

기존 설치 토큰은 `ghs_` 뒤에 영숫자 36자가 붙는 짧은 불투명 문자열이었다. 새 토큰은 같은 `ghs_` prefix를 유지하지만 JWT 형태(`Header.Payload.Signature`)를 띠고, 길이가 약 520자까지 늘어난다. 저장되는 데이터에 따라 더 길어질 여지도 있다.

```text
기존:  ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
새것:  ghs_xxxxx.xxxxxxxxx.xxxxxxxx
```

| 구분 | 기존 Token | 새 Token |
| --- | --- | --- |
| Prefix | `ghs_` | `ghs_` |
| 형식 | Opaque String | JWT 형태 |
| 길이 | 짧음(약 40자) | 약 520자 |
| `.` 포함 | 없음 | 2개 |
| 상태 | Stateful | Stateless |

GitHub는 이 변경이 토큰 발급 성능과 대규모 환경에서의 안정성을 위한 것이라고 설명한다.

## JWT처럼 생겼지만 JWT가 아니다

새 토큰이 점 두 개로 나뉜 JWT 형태라고 해서, 앱에서 이걸 디코드하거나 claim을 꺼내 쓰면 안 된다. 이 JWT는 GitHub 내부 issuer가 서명하며, 클라이언트가 직접 검증하거나 내부 데이터에 의존하도록 만든 게 아니다. 겉모습은 JWT지만 쓰임은 그냥 액세스 토큰이다. `Authorization: Bearer <token>`에 실어 보내고, 나머지는 GitHub API의 응답으로 판단하면 된다.

## 왜 기존 앱이 깨지나

문제는 토큰의 내부 형식을 코드가 가정한 자리에서 터진다. 주로 세 곳이다.

첫째, 길이 하드코딩이다. 아래 같은 검사는 새 토큰(약 520자)에서 곧바로 실패한다.

```csharp
if (token.Length != 40)
    throw new InvalidOperationException("Invalid GitHub token");
```

둘째, 정규식 검증이다. `ghs_[A-Za-z0-9]{36}`는 점이 없는 옛 형식만 매칭한다. 새 토큰에는 `.`이 들어가 통과하지 못한다. 두 형식을 모두 받으려면 GitHub가 안내하는 패턴을 쓰거나, 더 나은 방법으로 형식 검증 자체를 없앤다.

```regex
ghs_[A-Za-z0-9\.\-_]{36,}
```

셋째, DB 컬럼 길이다. 실무에서 제일 놓치기 쉽다. `VARCHAR(100)`에 저장하던 토큰이 잘려 버린다. GitHub는 최소 520자 이상을 수용하라고 안내한다.

```sql
-- 이전
InstallationToken VARCHAR(100)
-- 이후 (넉넉히)
InstallationToken NVARCHAR(1000)
```

컬럼을 늘리기 전에, 토큰을 장기 보관할 필요가 있는지부터 따져보는 편이 낫다. EF Core라면 엔티티의 `[MaxLength]`, API DTO의 길이 제한도 같이 본다.

## 미리 테스트하고 넘어가기

롤아웃을 기다릴 필요 없이 지금 확인할 수 있다. 설치 토큰 발급 API에 override 헤더를 붙이면 형식을 강제할 수 있다.

```http
POST /app/installations/{installation_id}/access_tokens

X-GitHub-Stateless-S2S-Token: enabled
```

| Header 값 | 결과 |
| --- | --- |
| `enabled` | 새 Stateless JWT Token |
| `disabled` | 기존 Stateful Token |
| 헤더 없음 | GitHub 롤아웃 정책에 따름 |

`enabled`, `disabled` 외의 값은 무시되고 기본 롤아웃 동작이 적용된다. 다만 이 헤더는 영구 설정이 아니다. 롤아웃이 끝나고 deprecated되면 형식을 제어할 수 없으니, 테스트 용도로만 쓰고 프로덕션 코드에서는 제거한다. 권장 순서는 이렇다. `enabled`로 새 토큰이 정상 처리되는지 확인하고, `disabled`로 옛 토큰도 되는지 확인한 뒤, 헤더를 빼고 롤아웃에 맡긴다.

## 권장 형태

결국 안전한 구현은 토큰을 문자열로만 다루는 것이다. 길이도, JWT 구조도, claim도 로직이 건드리지 않게 한다.

```csharp
var token = await GetInstallationAccessTokenAsync();

// 토큰 내부를 해석하지 않는다. 그대로 인증 정보로 쓴다.
httpClient.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", token);
```

로깅이나 테스트에서 형식을 구분해야 한다면 이 정도는 괜찮다. 단 유효성 검증 로직으로는 쓰지 않는다.

```csharp
var isStatelessToken =
    token.StartsWith("ghs_") && token.Count(c => c == '.') == 2;
```

## 지금 확인해 볼 것

.NET 프로젝트라면 `token.Length`, `Regex.IsMatch(token, ...)`, `JwtSecurityTokenHandler`, `[MaxLength(...)]` 네 패턴을 먼저 검색하자. 여기에 걸리는 곳과 DB 마이그레이션의 토큰 컬럼 길이를 손보면, 롤아웃이 언제 도달하든 앱이 조용히 깨지지 않는다. 지우면 되는 가정은 "40자다 / 영숫자뿐이다 / 점이 없다 / JWT로 디코드한다"이고, 남길 관점은 하나다. GitHub가 발급한 가변 길이 액세스 토큰을 그대로 Bearer로 쓴다.

## 참고

- [GitHub Changelog: Notice about upcoming new format for GitHub App installation tokens](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/)
- [GitHub Changelog: GitHub App installation tokens per-request override header](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
