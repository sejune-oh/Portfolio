# CLAUDE.md

이 저장소(`sejune-oh/Portfolio`)에서 작업할 때 지켜야 할 규칙과, article 자동 발행 파이프라인의 운영 계약입니다.

## Rules

1. **참조 전용 저장소(reference-only)**: 이 세션에 `sejune-oh/Portfolio` 외에 추가된 다른 저장소(예: `sejune-oh/Obsidian_claude`)는 **참조(읽기) 목적으로만** 사용한다. 해당 저장소들에는 파일 생성·수정·삭제, 커밋, 푸시 등 어떠한 변경 작업도 하지 않는다. 실제 개발·수정·생성 작업은 오직 `sejune-oh/Portfolio` 저장소에서만 수행한다.

2. **역할 구분**:
   - **Obsidian (`sejune-oh/Obsidian_claude`, `/workspace/obsidian_claude`)** = article 을 생성하기 위한 **자료(Resource) 소스**. 읽기 전용.
   - **Portfolio (이 저장소)** = 생성된 article 을 보여주는 **웹사이트**. 데이터 저장소는 **Notion**(블로그 = `NOTION_BLOG_DB`, 프로젝트 = `NOTION_DB`). "업로드"는 Notion API 로 Blog DB 에 페이지를 만드는 것을 의미한다.

3. **발행 전 항상 Obsidian 최신화**: article 을 생성/발행하기 전에 **반드시** Obsidian vault 를 최신으로 갱신한다.
   ```bash
   git -C /workspace/obsidian_claude pull --ff-only
   ```
   (clone 이 없으면 먼저 `add_repo` 후 clone. 이 갱신은 파이프라인의 1단계이며 생략 불가.)

4. **중복 article 금지**: 같은 글을 두 번 발행하지 않는다. 중복 판별 키는 **Slug**(`notion_slug`)이며, 두 겹으로 방어한다.
   - (a) Notion Blog DB 에 동일 Slug 페이지가 이미 있으면 skip.
   - (b) 로컬 ledger `automation/published-articles.json` 에 기록돼 있으면 skip.
   ledger 는 발행 이력의 SSOT 로서 **이 저장소에 커밋되어** 세션·컨테이너가 바뀌어도 상태가 유지된다.

## Article 생성(Generation)

Obsidian 자료에서 블로그 초안을 자동 생성하는 앞 단계. 상세 설계·문체 가이드·프롬프트는 `automation/ARTICLE-GENERATION.md` 참고. 요약:

- **선정**: `decisions/`·`knowledge/` 중 frontmatter 태그에 `article-candidate`(또는 `status/article-candidate`) 가 붙은 노트만. `node automation/find-article-candidates.mjs` 로 대상 목록을 뽑는다(생성 원장 `automation/generated-articles.json` 로 중복/변경 판별).
- **생성**: 소스 1건 → 아티클 1편. house-style(주제문 짧게, 아이콘·기호 남발 금지, 사실은 소스 기반, 참고는 실존 공식문서 링크)로 작성해 `content/articles/<slug>.md` 에 저장. frontmatter 는 `notion_published: false` + `status/needs-review`.
- **검토 게이트**: AI 는 초안까지만. 사람이 검토·수정 후 `status/needs-review` → `status/ready-to-publish` 로 승격해야 발행된다.

## Article 자동 발행 파이프라인

- **대상 범위**: 블로그 글만. `status/ready-to-publish` 태그가 있는 노트 두 소스 — (1) Obsidian `blog/*.md`(사람 작성), (2) Portfolio `content/articles/*.md`(AI 생성→사람 승인). `needs-review` 초안은 발행되지 않는다.
- **발행 상태**: frontmatter 의 `notion_published` 값을 그대로 따른다(`true` → 사이트 공개, `false` → 초안).
- **frontmatter → Notion Blog DB 필드 매핑**:

  | frontmatter        | Notion 속성  |
  | ------------------ | ------------ |
  | `notion_title`     | Title        |
  | `notion_slug`      | Slug         |
  | `notion_date`      | Date         |
  | `notion_category`  | Category     |
  | `notion_tags`      | Tags (쉼표 분리) |
  | `notion_summary`   | Summary      |
  | `notion_published` | Published    |
  | 본문(frontmatter 이후) | 페이지 블록  |

- **엔진**: `automation/publish-articles.mjs` (의존성 없는 Node ESM). 본문 변환은 `lib/notionWrite.ts` 의 `textToBlocks` 를 이식해 사이트 렌더와 일치시킨다.
  ```bash
  node automation/publish-articles.mjs --dry-run   # 무엇을 발행할지 미리보기(쓰기 없음)
  node automation/publish-articles.mjs             # 실제 발행 + ledger 갱신
  ```
  필요 env: `NOTION_TOKEN`, `NOTION_BLOG_DB` (이 실행 환경에 설정돼 있음). 선택: `OBSIDIAN_DIR`(기본 `/workspace/obsidian_claude`).

### 매일 실행 절차 (daily routine)

1. `git -C /workspace/obsidian_claude pull --ff-only` — Obsidian 최신화 (없으면 add_repo→clone).
2. `node automation/find-article-candidates.mjs` — 생성 대상(new/needs-regen) 파악. 대상이 있으면 각 소스노트를 `ARTICLE-GENERATION.md` 규칙대로 초안 생성해 `content/articles/` 에 저장하고 생성 원장을 갱신한다. 생성물은 `needs-review` 라 이번 실행에서 자동 발행되지 않는다(사람 검토 대기).
3. `node automation/publish-articles.mjs` — `status/ready-to-publish` 로 승격된 노트만 발행(중복은 자동 skip).
4. 원장(`published-articles.json`/`generated-articles.json`)·초안이 바뀌었으면 `sejune-oh/Portfolio` 작업 브랜치에 커밋·푸시.
5. 생성/발행/스킵/실패 요약을 보고. 새 생성·발행이 모두 0건이면 조용히 종료.
