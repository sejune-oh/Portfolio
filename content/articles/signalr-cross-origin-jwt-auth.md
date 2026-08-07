---
tags:
  - type/blog-post
  - status/needs-review
notion_title: "SignalR cross-origin + JWT 인증 설정"
notion_slug: signalr-cross-origin-jwt-auth
notion_date: 2026-08-07
notion_category: Backend
notion_tags: SignalR, ASP.NET Core, JWT, CORS
notion_summary: 브라우저 SignalR이 cross-origin에서 JWT로 인증하려면 CORS 자격증명, 쿼리스트링 토큰 인식, 클라이언트 accessTokenFactory 세 개가 동시에 맞아야 한다. 하나만 빠져도 negotiate나 WebSocket upgrade에서 끊긴다.
notion_published: false
source_notes:
  - knowledge/signalr-cross-origin-jwt-auth-setup.md
source_hash: 19d3e783d8b5
generated_at: 2026-08-07T00:00:00Z
---

**cross-origin에 JWT를 얹은 SignalR은 백엔드 설정 세 개가 동시에 맞아야 연결된다.** 하나라도 빠지면 negotiate나 WebSocket upgrade 단계에서 끊기는데, 에러 메시지가 엉뚱한 곳을 가리켜서 원인이 잘 안 보인다.

## 연결은 두 단계로 일어난다

브라우저 SignalR 클라이언트는 hub에 붙을 때 두 번 요청한다.

첫째, negotiate(POST)다. `Authorization: Bearer <jwt>` 헤더와 `Origin`을 담아 보낸다. cross-origin이라 응답에 CORS 헤더가 필요하고, JWT로 인증도 통과해야 connectionId가 발급된다.

둘째, WebSocket upgrade(GET)다. 여기가 함정이다. 브라우저는 WebSocket upgrade 요청에 `Authorization` 같은 커스텀 헤더를 붙이지 못한다. 그래서 SignalR은 토큰을 `?access_token=<jwt>` 쿼리스트링으로 보낸다. 서버가 이 쿼리 토큰을 읽어야 인증이 통과하고 101 Switching Protocols로 승격된다.

두 단계의 인증 경로가 다르다는 것이 아래 모든 설정의 이유다.

## 필요한 세 가지

첫째, CORS에서 자격 증명을 허용한다.

```csharp
options.AddDefaultPolicy(policy =>
{
    // AllowAnyOrigin() 과 AllowCredentials() 는 동시 사용 불가(CORS 스펙).
    // origin 을 echo 하는 SetIsOriginAllowed 로 credentials 와 호환시킨다.
    policy.SetIsOriginAllowed(_ => true);
    policy.AllowAnyHeader();
    policy.AllowAnyMethod();
    policy.AllowCredentials();
});
```

SignalR 클라이언트는 negotiate를 `withCredentials: true`로 보낸다. 응답에 `Access-Control-Allow-Credentials: true`가 없으면 브라우저가 응답을 막아 `TypeError: Failed to fetch`가 난다.

둘째, JWT가 쿼리스트링 토큰을 읽게 한다. ASP.NET Core의 `AddJwtBearer`는 기본적으로 헤더만 보고 쿼리스트링 `access_token`은 읽지 않는다. upgrade에서 토큰이 쿼리로 오므로 `OnMessageReceived`에서 hub 경로일 때만 쿼리 토큰을 집어 준다.

```csharp
options.Events = new JwtBearerEvents
{
    OnMessageReceived = context =>
    {
        var accessToken = context.Request.Query["access_token"];
        if (!string.IsNullOrEmpty(accessToken)
            && context.Request.Path.StartsWithSegments("/hubs"))
        {
            context.Token = accessToken;
        }
        return Task.CompletedTask;
    },
};
```

경로를 `/hubs`로 한정하는 이유는, 일반 API는 헤더로 받아야 하고 쿼리스트링에 실린 토큰은 액세스 로그에 남기 때문이다.

셋째, 클라이언트에서 `accessTokenFactory`를 설정한다.

```typescript
new HubConnectionBuilder()
  .withUrl(hubUrl, { accessTokenFactory: () => getMyJwt() })
  .withAutomaticReconnect()
  .build();
```

이 콜백 하나가 negotiate의 Authorization 헤더와 upgrade의 `access_token` 쿼리를 둘 다 채운다. 빠지면 negotiate부터 401이다.

## 미들웨어 순서가 곧 설정이다

```csharp
app.UseCors();            // hub upgrade 응답에 CORS 헤더가 먼저 붙어야 한다
app.UseAuthentication();  // 쿼리 토큰 검증(OnMessageReceived)
app.UseAuthorization();
app.MapHub<MyHub>("/hubs/my-hub");
```

`UseCors`가 `MapHub` 뒤에 오면 preflight 응답에 CORS 헤더가 없어 차단되고, `UseAuthentication`이 뒤에 오면 `[Authorize]`가 토큰을 못 본다.

## 증상으로 원인 좁히기

| 단계 | 정상 | 실패 시 원인 |
|---|---|---|
| `OPTIONS .../negotiate` | 204 + CORS 헤더 | CORS 정책 또는 AllowCredentials 누락 |
| `POST .../negotiate` | 200 + connectionId | 401이면 JWT 헤더 누락 또는 만료 |
| `GET ...?access_token=` (upgrade) | 101 Switching Protocols | 401이면 OnMessageReceived 누락, 404면 경로 오타 |

이 표만 있어도 "Failed to fetch"나 "connection could not be found on the server" 같은 모호한 에러를 어느 설정 문제로 좁힐 수 있다.

## 자주 밟는 지뢰

`AllowAnyOrigin().AllowCredentials()`는 런타임에 예외를 던진다. 모든 origin을 허용하면서 자격 증명도 쓰려면 origin을 echo하는 `SetIsOriginAllowed(_ => true)`를 쓴다.

`Sec-WebSocket-*` 헤더는 브라우저가 자동으로 붙이고 바꿀 수 없다. CORS `Access-Control-Allow-Headers`에 굳이 명시하지 않는다.

`accessTokenFactory`(JWT 흐름)와 쿠키 인증(`withCredentials`)을 동시에 쓰지 않는다. 의도를 정해 한 가지만 쓴다.

## 참고

- [Microsoft Learn: Authentication and authorization in ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/authn-and-authz)
- [Microsoft Learn: Enable CORS in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/cors)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
