# Obsidian fork 자동 동기화 (C 방식)

이 자동화가 읽는 자료 소스는 fork **`sejune-oh/Obsidian_claude`** 이고,
실제 편집·태깅은 원본 **`SejuneOh/Obsidian_claude`**(upstream)에서 이뤄진다.
fork 는 upstream 을 그대로 따라가는 **순수 미러**로 유지한다(독자 커밋 없음).

## 동작

`.github/workflows/sync-obsidian-fork.yml` (이 Portfolio 저장소에 위치)가 매일 그리고
수동 실행 시 upstream → fork 를 fast-forward 로 동기화한다. fork 안에는 아무 파일도
넣지 않으므로 미러가 깨지지 않는다.

```
매일  ① (GitHub Actions in Portfolio) upstream → fork 동기화   [23:30 UTC]
  →  ② (실행 환경 routine) fork pull → 후보 탐색 → 생성 → 발행  [이후]
```

## 1회 설정 (사용자)

1. **PAT 발급** — 두 저장소에 접근 가능한 토큰.
   - classic: scope `repo`
   - fine-grained: `SejuneOh/Obsidian_claude` Contents(Read) + `sejune-oh/Obsidian_claude` Contents(Read/Write).
     두 계정 소유자가 다르면 각 계정에서 각각 발급이 필요할 수 있다.
2. **Secret 등록** — `sejune-oh/Portfolio` → Settings → Secrets and variables → Actions →
   New repository secret → 이름 `OBSIDIAN_SYNC_TOKEN`, 값 = 위 PAT.
3. **동작 확인** — Actions 탭 → "Sync Obsidian fork from upstream" → Run workflow(수동)로 1회 실행.
   성공하면 fork `main` 이 upstream 최신 커밋까지 따라온다.

## 전제

- fork 에 upstream 에 없는 독자 커밋이 있으면 fast-forward 가 실패한다(divergence).
  fork 는 절대 직접 편집·커밋하지 않는다(참조 전용).
- fork 는 upstream 의 fork 여야 한다(공유 히스토리 필요). 현재 조건 충족.
