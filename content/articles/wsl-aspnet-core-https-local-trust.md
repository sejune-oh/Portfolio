---
tags:
  - type/blog-post
  - status/needs-review
notion_title: "WSL에서 ASP.NET Core HTTPS를 Windows와 .NET 양쪽이 신뢰하게 만들기"
notion_slug: wsl-aspnet-core-https-local-trust
notion_date: 2026-08-07
notion_category: Backend
notion_tags: WSL2, ASP.NET Core, HTTPS, Kestrel, mkcert
notion_summary: WSL에서 띄운 HTTPS 앱은 Windows 브라우저와 WSL의 .NET HttpClient라는 분리된 두 신뢰 저장소를 모두 통과해야 한다. dev-certs만으로 안 되는 이유와, Windows dev-cert 공유 방식과 mkcert 로컬 CA 방식 두 가지 해법.
notion_published: false
source_notes:
  - knowledge/wsl2-aspnet-core-https-dev-cert-공유.md
  - knowledge/setting-the-ssl-for-connect-between-wsl-to-window.md
source_hash: "7e3532dc2a5a, 2e9f5f73504e"
generated_at: 2026-08-07T00:00:00Z
---

**WSL에서 띄운 HTTPS 앱은 신뢰 저장소를 두 번 통과해야 한다.** Windows 브라우저와 WSL 안의 .NET HttpClient가 서로 다른 저장소를 보기 때문이다. 이 둘을 헷갈리면 "curl은 되는데 앱은 안 되는" 상태에 갇힌다.

## 신뢰 저장소가 둘이다

WSL에서 ASP.NET Core 앱을 HTTPS로 띄우면 두 종류의 클라이언트가 인증서를 검증한다. Windows 브라우저는 Windows 신뢰 저장소를 보고, WSL 안의 .NET HttpClient(앱 간 호출, OIDC discovery, JWKS 조회 등)는 WSL의 OpenSSL 번들(`/etc/ssl/certs/ca-certificates.crt`)을 본다. 둘은 분리돼 있어서, 인증서를 서명한 root CA를 양쪽에 각각 등록해야 한다.

게다가 `dotnet dev-certs https --trust`는 Windows와 macOS 사용자 저장소에만 동작하고, Linux/WSL에서는 무시된다. WSL 안의 dotnet은 자기만의 dev-cert를 갖는데 Windows는 그걸 모르므로 브라우저가 거부한다.

## dev-certs만으로 안 되는 이유

`dotnet dev-certs https`는 self-signed **leaf** 인증서(`CA:FALSE`)를 발급한다. curl은 leaf가 번들에 있으면 관대하게 받아들이지만, .NET의 `X509Chain`은 root anchor에 `CA:TRUE`를 요구한다. self-signed leaf는 root로 인정하지 않는다. 그래서 curl은 통과하고 .NET HttpClient만 실패하는 패턴이 나온다.

여기서 필요한 신뢰 범위에 따라 두 갈래로 갈린다.

## 방법 1. Windows dev-cert를 WSL에 공유

Windows 브라우저만 신뢰시키면 되는 가장 가벼운 길이다. Windows에서 이미 신뢰된 dev-cert를 PFX로 내보내고, WSL의 Kestrel이 그 PFX를 쓰도록 환경 변수로 주입한다.

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

양쪽이 같은, 이미 신뢰된 인증서를 쓰게 되어 브라우저 경고가 사라진다.

## 방법 2. mkcert로 로컬 CA 만들기

WSL 안의 .NET HttpClient가 자기 앱의 HTTPS를 호출한다면(OIDC discovery, JWKS 등) 방법 1로는 부족하다. `X509Chain`이 `CA:TRUE` root를 요구하기 때문이다. mkcert는 로컬 CA(`CA:TRUE`)를 발급해 신뢰 저장소에 등록하고, 그 CA로 leaf를 서명해 정상적인 체인을 만든다.

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

같은 rootCA를 Windows 신뢰 저장소에도 import하면 브라우저도 통과한다. `.pem`은 Windows에서 자동 연결되지 않으니 `.crt`로 복사하거나 PowerShell `Import-Certificate`를 쓴다.

주의할 함정 하나. mkcert는 사용자별 CAROOT를 가진다. `sudo mkcert -install`은 root의 CA를 시스템 저장소에 넣는데, 이후 일반 권한으로 `mkcert`를 호출하면 user 홈에 다른 CA가 새로 생겨 발급한 인증서가 신뢰되지 않는다. 모든 mkcert 명령을 sudo로 통일하거나 root의 CA를 user 홈으로 복사해 쓴다.

## 어느 쪽을 쓸까

Windows 브라우저에서 보기만 하면 되면 방법 1로 충분하다. WSL 내부의 .NET 코드가 자기 앱의 HTTPS 엔드포인트를 호출한다면 방법 2가 필요하다.

## 진단 신호로 위치 잡기

TLS 경고 코드가 진행 상태를 알려준다.

| 신호 | 의미 |
|---|---|
| `sslv3 certificate unknown` | 클라이언트가 CA를 모름. root CA 미등록 |
| `tlsv1 unknown ca` | 인증서는 받았으나 CA를 신뢰 못함. PFX는 적용됐고 신뢰 등록만 남음 |
| `Cannot determine the frame size` | 인증서 무관. HTTPS 포트에 평문이 들어옴(스킴 오타) |

Kestrel 로그의 `Failed to authenticate HTTPS connection`은 서버가 본 인바운드 거부다. 외부 호출 실패로 오해하지 않는다.

## 자주 밟는 지뢰

`dotnet dev-certs https --clean`은 thumbprint를 바꾸므로 이후 PFX를 반드시 다시 내보낸다. `--trust` 다이얼로그에서 아니오를 눌러도 명령은 성공으로 끝날 수 있으니, `--check --verbose`로 "A trusted certificate was found"를 재확인한다. Firefox는 별도 NSS 저장소를 쓰므로 Windows 신뢰만으로는 안 되고 따로 import한다. Kestrel은 인증서 hot reload가 안 되니 교체 후 재시작한다.

## 참고

- [Microsoft Learn: Enforce HTTPS in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/enforcing-ssl)
- [mkcert (FiloSottile/mkcert)](https://github.com/FiloSottile/mkcert)
- [WSL dev-certs 신뢰 한계 안내](https://aka.ms/dev-certs-trust)
