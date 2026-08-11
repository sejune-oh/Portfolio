---
tags:
  - type/blog-post
  - status/ready-to-publish
notion_title: "SignalR cross-origin + JWT 인증 설정"
notion_slug: signalr-cross-origin-jwt-auth
notion_date: 2026-08-07
notion_category: Backend
notion_tags: SignalR, ASP.NET Core, JWT, CORS
notion_summary: 브라우저 SignalR이 cross-origin에서 JWT로 인증하려면 CORS 자격증명, 쿼리스트링 토큰 인식, 클라이언트 accessTokenFactory 세 개가 동시에 맞아야 한다. 하나만 빠져도 negotiate나 WebSocket upgrade에서 끊긴다.
notion_published: true
source_notes:
  - knowledge/signalr-cross-origin-jwt-auth-setup.md
source_hash: 19d3e783d8b5
generated_at: 2026-08-07T00:00:00Z
---

로컬에서 잘 붙던 SignalR이 클라이언트를 다른 origin에 올리고 JWT 인증을 걸자 연결이 안 된다. 게다가 에러 메시지가 `TypeError: Failed to fetch`나 "connection could not be found on the server"처럼 엉뚱한 곳을 가리켜서 어디가 문제인지 잘 안 보인다.

원인은 대개 하나가 아니라 셋이다. cross-origin에 JWT를 얹은 SignalR은 백엔드 설정 세 개가 동시에 맞아야 붙고, 하나만 빠져도 조용히 실패한다. 왜 셋이나 필요한지는 연결이 어떻게 일어나는지 보면 자연스럽게 풀린다.

## 연결은 두 단계다

브라우저 SignalR 클라이언트는 hub에 붙을 때 요청을 두 번 보낸다.

첫 번째는 negotiate(POST)다. `Authorization: Bearer <jwt>` 헤더와 `Origin`을 담아 보내고, cross-origin이라 응답에 CORS 헤더가 있어야 하며 JWT로 인증도 통과해야 connectionId가 나온다.

두 번째가 WebSocket upgrade(GET)인데, 여기에 함정이 있다. 브라우저는 upgrade 요청에 `Authorization` 같은 커스텀 헤더를 붙이지 못한다. 그래서 SignalR은 토큰을 `?access_token=<jwt>` 쿼리스트링에 실어 보낸다. 서버가 이 쿼리 토큰을 읽어야 인증이 통과하고 101 Switching Protocols로 넘어간다.

두 단계의 인증 경로가 다르다는 것, 이게 아래 설정 세 개가 모두 필요한 이유다.

## 세 개를 맞춘다

첫째, CORS에서 자격 증명을 허용한다.

```csharp
options.AddDefaultPolicy(policy =>
{
    // AllowAnyOrigin() 과 AllowCredentials() 는 함께 못 쓴다(CORS 스펙).
    // origin 을 echo 하는 SetIsOriginAllowed 로 credentials 와 맞춘다.
    policy.SetIsOriginAllowed(_ => true);
    policy.AllowAnyHeader();
    policy.AllowAnyMethod();
    policy.AllowCredentials();
});
```

SignalR 클라이언트는 negotiate를 `withCredentials: true`로 보낸다. 응답에 `Access-Control-Allow-Credentials: true`가 없으면 브라우저가 응답을 막아 `TypeError: Failed to fetch`가 뜬다.

둘째, JWT가 쿼리스트링 토큰을 읽게 한다. `AddJwtBearer`는 기본적으로 헤더만 보고 쿼리스트링 `access_token`은 무시한다. upgrade에서 토큰이 쿼리로 오니, `OnMessageReceived`에서 hub 경로일 때만 그 값을 집어 준다.

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

경로를 `/hubs`로 한정하는 데는 이유가 있다. 일반 API는 헤더로 받아야 하고, 쿼리스트링에 실린 토큰은 액세스 로그에 남기 때문이다.

셋째, 클라이언트에서 `accessTokenFactory`를 넘긴다.

```typescript
new HubConnectionBuilder()
  .withUrl(hubUrl, { accessTokenFactory: () => getMyJwt() })
  .withAutomaticReconnect()
  .build();
```

이 콜백 하나가 negotiate의 Authorization 헤더와 upgrade의 `access_token` 쿼리를 둘 다 채운다. 빠지면 negotiate부터 401이다.

## 순서도 설정이다

세 개를 다 넣어도 미들웨어 순서가 틀리면 안 붙는다.

```csharp
app.UseCors();            // hub upgrade 응답에 CORS 헤더가 먼저 붙어야 한다
app.UseAuthentication();  // 쿼리 토큰 검증(OnMessageReceived)
app.UseAuthorization();
app.MapHub<MyHub>("/hubs/my-hub");
```

`UseCors`가 `MapHub` 뒤로 가면 preflight 응답에 CORS 헤더가 없어 막히고, `UseAuthentication`이 뒤로 가면 `[Authorize]`가 토큰을 못 본다.

## 증상으로 범위를 좁힌다

막혔을 때는 요청 단계별 응답을 보면 어느 설정이 빠졌는지 좁혀진다.

| 단계 | 정상 | 실패 시 원인 |
|---|---|---|
| `OPTIONS .../negotiate` | 204 + CORS 헤더 | CORS 정책 또는 AllowCredentials 누락 |
| `POST .../negotiate` | 200 + connectionId | 401이면 JWT 헤더 누락 또는 만료 |
| `GET ...?access_token=` (upgrade) | 101 Switching Protocols | 401이면 OnMessageReceived 누락, 404면 경로 오타 |

몇 가지는 미리 알아두면 시간을 아낀다. `AllowAnyOrigin().AllowCredentials()`는 런타임에 예외를 던지니, 모든 origin을 열면서 자격 증명도 쓰려면 origin을 echo하는 `SetIsOriginAllowed(_ => true)`를 쓴다. `Sec-WebSocket-*` 헤더는 브라우저가 알아서 붙이므로 CORS `Access-Control-Allow-Headers`에 명시할 필요가 없다. `accessTokenFactory`(JWT 흐름)와 쿠키 인증(`withCredentials`)은 섞지 말고 하나만 정한다.

## 지금 확인해 볼 것

연결이 안 되면 DevTools Network 탭에서 negotiate와 upgrade 두 요청의 상태 코드부터 본다. 위 표와 맞춰 보면 세 설정 중 무엇이 빠졌는지 바로 짚인다.

## 참고

- [Microsoft Learn: Authentication and authorization in ASP.NET Core SignalR](https://learn.microsoft.com/en-us/aspnet/core/signalr/authn-and-authz)
- [Microsoft Learn: Enable CORS in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/cors)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
