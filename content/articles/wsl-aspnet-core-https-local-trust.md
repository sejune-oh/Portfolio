---
tags:
  - type/blog-post
  - status/ready-to-publish
notion_title: "WSL 로컬 HTTPS 인증서 신뢰 설정"
notion_slug: wsl-aspnet-core-https-local-trust
notion_date: 2026-08-07
notion_category: Backend
notion_tags: WSL2, ASP.NET Core, HTTPS, Kestrel, mkcert
notion_summary: WSL에서 띄운 HTTPS 앱은 Windows 브라우저와 WSL의 .NET HttpClient라는 분리된 두 신뢰 저장소를 모두 통과해야 한다. dev-certs만으로 안 되는 이유와, Windows dev-cert 공유 방식과 mkcert 로컬 CA 방식 두 가지 해법.
notion_published: true
source_notes:
  - knowledge/wsl2-aspnet-core-https-dev-cert-공유.md
  - knowledge/setting-the-ssl-for-connect-between-wsl-to-window.md
source_hash: "7e3532dc2a5a, 2e9f5f73504e"
generated_at: 2026-08-07T00:00:00Z
---

WSL에서 앱을 HTTPS로 띄웠는데, curl로는 잘 되던 것이 정작 앱의 `.NET HttpClient` 호출에서는 인증서 오류로 막힌다. 아니면 Windows 브라우저에서 경고가 뜬다. 둘 다 같은 뿌리에서 나온다. WSL의 HTTPS는 신뢰 저장소를 두 번 통과해야 하는데, 그 둘이 서로 다르기 때문이다.

## 신뢰 저장소가 둘이다

WSL에서 ASP.NET Core 앱을 HTTPS로 띄우면 인증서를 검증하는 쪽이 둘로 나뉜다. Windows 브라우저는 Windows 신뢰 저장소를 보고, WSL 안의 `.NET HttpClient`(앱 간 호출, OIDC discovery, JWKS 조회 등)는 WSL의 OpenSSL 번들(`/etc/ssl/certs/ca-certificates.crt`)을 본다. 둘은 분리돼 있어서 인증서를 서명한 root CA를 양쪽에 각각 등록해야 한다.

여기에 함정이 하나 더 있다. `dotnet dev-certs https --trust`는 Windows와 macOS 사용자 저장소에만 동작하고 Linux/WSL에서는 그냥 무시된다. WSL 안의 dotnet은 자기만의 dev-cert를 갖는데 Windows는 그걸 모르니 브라우저가 거부한다.

## dev-certs만으로 안 되는 이유

한 걸음 더 들어가 보자. `dotnet dev-certs https`는 self-signed leaf 인증서(`CA:FALSE`)를 발급한다. curl은 leaf가 번들에 있으면 관대하게 받아들이지만, `.NET`의 `X509Chain`은 root anchor에 `CA:TRUE`를 요구한다. self-signed leaf를 root로 인정하지 않는다. curl은 통과하는데 `.NET HttpClient`만 실패하는, 처음엔 이해가 안 가는 패턴이 여기서 나온다.

그래서 필요한 신뢰 범위에 따라 길이 둘로 갈린다.

## 방법 1. Windows dev-cert를 WSL에 공유

Windows 브라우저만 신뢰시키면 되는 경우가 가장 가볍다. Windows에서 이미 신뢰된 dev-cert를 PFX로 내보내고, WSL의 Kestrel이 그 PFX를 쓰도록 환경 변수로 넘긴다.

```powershell
$pfxPath = "$env:USERPROFILE\.aspnet\https\aspnetapp.pfx"
dotnet dev-certs https --clean
dotnet dev-certs https -ep $pfxPath -p "DevPass!2026"
dotnet dev-certs https --check --trust   # 다이얼로그가 뜨면 예
```

```bash
export ASPNETCORE_Kestrel__Certificates__Default__Path="/mnt/c/Users/<USER>/.aspnet/https/aspnetapp.pfx"
export ASPNETCORE_Kestrel__Certificates__Default__Password="DevPass!2026"
dotnet run --project src/<Project>
```

양쪽이 같은, 이미 신뢰된 인증서를 쓰게 되니 브라우저 경고가 사라진다.

## 방법 2. mkcert로 로컬 CA 만들기

WSL 안의 `.NET HttpClient`가 자기 앱의 HTTPS를 호출한다면 방법 1로는 부족하다. 앞서 본 것처럼 `X509Chain`이 `CA:TRUE` root를 요구하기 때문이다. mkcert는 로컬 CA(`CA:TRUE`)를 발급해 신뢰 저장소에 등록하고, 그 CA로 leaf를 서명해 정상 체인을 만든다.

```bash
sudo mkcert -install
sudo mkcert -cert-file /tmp/localhost.crt -key-file /tmp/localhost.key localhost 127.0.0.1 ::1
sudo chown $USER:$USER /tmp/localhost.crt /tmp/localhost.key
openssl pkcs12 -export -out /path/to/aspnetapp.pfx \
  -inkey /tmp/localhost.key -in /tmp/localhost.crt -passout pass:1111
```

```json
{ "Kestrel": { "Certificates": { "Default": {
  "Path": "/path/to/aspnetapp.pfx", "Password": "1111" } } } }
```

같은 rootCA를 Windows 신뢰 저장소에도 import하면 브라우저도 통과한다. `.pem`은 Windows에서 더블클릭으로 안 열리니 `.crt`로 복사하거나 PowerShell `Import-Certificate`를 쓴다.

여기서 자주 막히는 함정이 하나 있다. mkcert는 사용자별 CAROOT를 갖는다. `sudo mkcert -install`은 root의 CA를 시스템 저장소에 넣는데, 이후 일반 권한으로 `mkcert`를 부르면 user 홈에 다른 CA가 새로 생겨 발급한 인증서가 신뢰되지 않는다. mkcert 명령을 모두 sudo로 통일하거나 root의 CA를 user 홈으로 복사해 쓰면 일관성이 유지된다.

## 어느 쪽을 쓰나

정리하면 간단하다. Windows 브라우저에서 보기만 하면 되면 방법 1로 충분하다. WSL 내부의 `.NET` 코드가 자기 앱의 HTTPS 엔드포인트를 호출한다면 방법 2가 필요하다.

## 증상으로 위치 잡기

막혔을 때는 TLS 경고 코드가 어디까지 왔는지 알려준다.

| 신호 | 의미 |
|---|---|
| `sslv3 certificate unknown` | 클라이언트가 CA를 모름. root CA 미등록 |
| `tlsv1 unknown ca` | 인증서는 받았으나 CA를 신뢰 못함. PFX는 적용됐고 신뢰 등록만 남음 |
| `Cannot determine the frame size` | 인증서 무관. HTTPS 포트에 평문이 들어옴(스킴 오타) |

Kestrel 로그의 `Failed to authenticate HTTPS connection`은 서버가 본 인바운드 거부다. 외부 호출이 실패한 것으로 오해하지 않는다. 그 밖에 `dotnet dev-certs https --clean`은 thumbprint를 바꾸니 이후 PFX를 다시 내보내야 하고, `--trust`에서 아니오를 눌러도 명령은 성공으로 끝날 수 있으니 `--check --verbose`로 "A trusted certificate was found"를 다시 확인한다. Firefox는 별도 NSS 저장소를 쓰므로 Windows 신뢰만으로는 안 되고 따로 import한다. Kestrel은 인증서 hot reload가 안 되니 교체 후 재시작한다.

## 지금 확인해 볼 것

지금 겪는 게 브라우저 경고인지 앱의 `HttpClient` 실패인지부터 가른다. 브라우저만이면 방법 1, 앱 내부 호출까지면 방법 2로 간다. 그다음 위 신호 표로 어느 단계에서 막혔는지 맞춰 보면 남은 작업이 분명해진다.

## 참고

- [Microsoft Learn: Enforce HTTPS in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/enforcing-ssl)
- [mkcert (FiloSottile/mkcert)](https://github.com/FiloSottile/mkcert)
- [WSL dev-certs 신뢰 한계 안내](https://aka.ms/dev-certs-trust)

이 글은 AI가 사실을 기반으로 작성한 글입니다.
