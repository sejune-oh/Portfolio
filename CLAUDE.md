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

## Article 자동 발행 파이프라인

- **대상 범위**: 블로그 글만. Obsidian `blog/*.md` 중 `tags:` 에 `status/ready-to-publish` 가 있는 노트.
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
2. `node automation/publish-articles.mjs` — ready-to-publish 노트 발행(중복은 자동 skip).
3. ledger(`automation/published-articles.json`)가 바뀌었으면 `sejune-oh/Portfolio` 의 작업 브랜치에 커밋·푸시.
4. 발행/스킵/실패 요약을 보고. 발행 0건(모두 중복)이면 조용히 종료.
