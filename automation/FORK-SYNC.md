# Obsidian 미러 백업 + 소스 동기화

## 목적

- **자료 소스(upstream)**: `SejuneOh/Obsidian_claude` — 실제 Obsidian vault 를 편집·태깅하는 repo(회사 계정).
- **개인 미러(fork)**: `sejune-oh/Obsidian_claude` — upstream 을 그대로 따라가는 **영구 백업**. 회사 계정이 사라져도 기록이 남는다.
- 이 article 자동화(실행 환경)는 cross-tier 제약으로 upstream 에 직접 접근하지 못하므로 **개인 미러(`sejune-oh/Obsidian_claude`)를 읽는다.**

미러가 항상 최신이면, 자동화는 개인 fork 만 읽어도 upstream 과 동일한 자료를 본다.

## 왜 이 설계인가 (fork cron 제약)

GitHub 은 **fork 저장소에서 `schedule`(cron) 워크플로우를 비활성화**한다. 그래서 fork(`sejune-oh/*`) 안에 스케줄 sync 를 두는 방식은 자동 실행이 안 된다. 대신 **upstream 에 `on: push` 워크플로우**를 두면, upstream 이 갱신/병합될 때마다 이벤트로 미러가 돌아간다(‑push 트리거는 정상 동작).

```
[vault 편집·태깅] → push → SejuneOh/Obsidian_claude(upstream)
                              │ on:push → PAT 로 강제 미러
                              ▼
                        sejune-oh/Obsidian_claude(개인 fork = 백업, 자동화 소스)
```

## 워크플로우 (upstream `SejuneOh/Obsidian_claude` 에 추가)

`.github/workflows/mirror-to-personal.yml`

```yaml
name: Mirror to personal backup fork

on:
  push:
    branches: ["main"]
  workflow_dispatch: {}      # 기존 커밋을 지금 한 번 미러하고 싶을 때 수동 실행

permissions:
  contents: read

concurrency:
  group: mirror-personal-fork
  cancel-in-progress: false

jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout upstream (full history)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Force-mirror main to personal fork
        env:
          MIRROR_TOKEN: ${{ secrets.MIRROR_TOKEN }}
        run: |
          if [ -z "$MIRROR_TOKEN" ]; then
            echo "::error::MIRROR_TOKEN secret 미설정" >&2; exit 1
          fi
          git push --force \
            "https://x-access-token:${MIRROR_TOKEN}@github.com/sejune-oh/Obsidian_claude.git" \
            HEAD:refs/heads/main
```

## 1회 설정 (사용자)

1. **PAT 발급** — 개인 계정(`sejune-oh`)에서 발급.
   - fine-grained: `sejune-oh/Obsidian_claude` = Contents(Read and write).
   - classic: scope `repo`.
2. **Secret 등록** — **upstream** `SejuneOh/Obsidian_claude` → Settings → Secrets and variables → Actions →
   New repository secret → 이름 `MIRROR_TOKEN`, 값 = 위 PAT.
3. **워크플로우 추가** — 위 YAML 을 upstream repo 의 `.github/workflows/mirror-to-personal.yml` 로 커밋.
4. **기존 커밋 미러(1회)** — Actions 탭 → "Mirror to personal backup fork" → Run workflow(수동)로 현재 upstream HEAD 를 fork 로 반영.

## 전제 / 주의

- 개인 fork 는 **순수 미러**다. fork 에 직접 커밋하지 않는다(force-push 로 항상 upstream 과 일치시키므로 독자 커밋은 덮인다).
- **보안**: 회사 repo 에 개인 PAT 를 secret 으로 두는 것이 정책상 불가하면, upstream 에서 `repository_dispatch` 로 fork 워크플로우를 깨우는 방식(fork 는 dispatch 트리거는 허용, schedule 만 불가)으로 대체 가능.
- 미러는 이벤트(push) 기반이라 upstream 병합 직후 수 초~수 분 내 반영된다.
