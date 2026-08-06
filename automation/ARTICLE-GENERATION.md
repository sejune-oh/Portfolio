# Article 생성(Generation) 설계

Obsidian 자료 소스에서 블로그 아티클 **초안**을 자동 생성하는 단계의 설계 문서.
발행(publish) 단계는 `publish-articles.mjs` + `CLAUDE.md` 참고. 이 문서는 그 **앞 단계**를 정의한다.

## 전체 흐름

```
[Obsidian 소스노트]        ① 선정        ② 생성(AI)         ③ 검토 게이트       ④ 발행
 decisions/ · knowledge/  →  opt-in 태그  →  house-style    →  사람이 승인      →  기존 publish
 (참조 전용)                 로 후보 추림    초안 markdown       (ready 표시)       파이프라인
                                            (Portfolio 저장)
```

핵심 원칙: **AI는 초안까지만. 공개(발행)는 사람이 승인한 것만.**

## 확정된 결정 (v1)

| 항목 | 결정 |
| --- | --- |
| 선정 신호 | Obsidian 노트에 **`status/article-candidate`** 태그를 사람이 붙인다(opt-in). |
| 생성 대상 범위 | `decisions/` + `knowledge/` 두 폴더만. |
| 검토 게이트 | 생성물은 초안(draft)으로만 나오고, 사람 검토·승인 후에만 발행. |
| 초안 저장 위치 | **Portfolio 저장소** `content/articles/<slug>.md` (Obsidian은 참조 전용이라 역기입 금지). |
| 발행 상태 | 생성 시 `notion_published: false` + `status/needs-review`. 사람이 승인 시 `status/ready-to-publish`(+필요 시 published:true)로 승격. |

## ① 선정 (candidate 탐색)

- 대상: `decisions/*.md`, `knowledge/*.md` 중 frontmatter `tags:` 에 **`status/article-candidate`** 가 있는 노트.
- 이미 생성된 소스는 제외한다 — 생성 원장 `automation/generated-articles.json` 의 `sourcePath` + `sourceHash` 로 판별.
  - 원장에 없음 → 신규 생성.
  - 원장에 있고 해시 동일 → skip.
  - 원장에 있고 **해시 변경**(소스가 수정됨) → `needs-regen` 으로 표시(자동 덮어쓰기 대신 사람이 판단).
- 헬퍼: `node automation/find-article-candidates.mjs` — 위 규칙으로 생성 대상 목록(JSON)을 출력한다. AI 는 이 목록만 받아 생성하므로 선정은 결정적(deterministic).

## ② 생성 (AI)

소스노트 1건 → 아티클 1편(1:1). 클러스터링(여러 노트→1편)은 v2.

**출력 위치·형식**: `content/articles/<notion_slug>.md`, frontmatter는 아래.

```yaml
---
tags:
  - type/blog-post
  - status/needs-review        # 검토 전. 승인 시 status/ready-to-publish 로 교체
notion_title: <제목>
notion_slug: <ascii-kebab-slug>
notion_date: <YYYY-MM-DD>       # 생성일
notion_category: <카테고리>     # 고정 목록 없음. 소스 내용 기반으로 생성기가 자동 분류
notion_tags: <쉼표, 구분, 태그>
notion_summary: <2~3문장 요약>
notion_published: false         # 검토 전엔 항상 false
source_notes:                   # 출처(provenance) — 발행 파이프라인은 무시, 추적용
  - <obsidian 상대경로>
source_hash: <소스 content sha256 앞 12자>
generated_at: <ISO8601>
---

<본문>
```

### House-style (문체 가이드)

기존 발행 글(`blog/blog-loop-engineering-*.md`)의 톤을 기준으로 한다.

- **주제문 먼저, 짧게.** 첫 문단은 굵은 한 문장으로 핵심을 던지되 길게 늘이지 않는다. 한 호흡에 읽히는 길이.
- **구체적 수치·사실 우선.** "빨라졌다" 대신 "0.04초에서 91초". 소스노트에 없는 수치는 지어내지 않는다.
- 짧고 단정적인 한국어. 군더더기·과장·마케팅 표현 배제.
- **AI 티 나는 장식 금지.** 본문에 아이콘·이모지(✅ ❌ ⚠️ 등)를 쓰지 않는다. `--`, `__`, `==`, em-dash(—), 화살표(→) 같은 기호를 문장에 연속·남발하지 않는다. 구분이 필요하면 마침표로 문장을 끊는다. 강조는 꼭 필요할 때만 굵게. (표·코드블록 안의 기호는 예외.)
- `##`/`###` 소제목으로 구획. 코드는 펜스(```lang), 언어 표기 필수(하이라이트·Notion 매핑용).
- 목록은 `-`. 표는 필요할 때만. 표 셀에도 아이콘 대신 "필수/중복/불필요" 같은 텍스트를 쓴다.
- 길이: 800~2000자 본문 권장. 소스가 얇으면 억지로 늘리지 않는다.
- **사실은 resource(소스노트) 기반.** 본문의 주장·수치·코드는 소스노트에 근거해야 한다. 새 주장/벤치마크/인용을 만들지 않는다. 불확실하면 뺀다.
- **추가 자료가 필요하면 웹의 사실 기반 공식 문서를 참조**하고 본문 하단 `## 참고` 섹션에 링크한다. 단, **실제 존재하는 권위 있는 문서(공식 docs 등)만**. 링크를 지어내지 않는다. 소스노트가 이미 인용한 문서 링크는 그대로 신뢰해 사용한다. 소스에 없는 링크를 새로 다는 경우 실존을 확인한다.
- 카테고리(`notion_category`)는 고정 목록 없이 소스 내용에 맞춰 자동 분류한다.
- 코드/기술용어는 원문 유지. 회사·이슈번호 등 민감정보는 소스에 공개돼 있는 수준만.

### 생성 프롬프트(재사용)

> 아래 Obsidian 소스노트를 개발 블로그 아티클 **초안**으로 재구성하라.
> - 독자: 백엔드/풀스택 엔지니어. 목적: 저자의 실무 문제 해결 과정을 공유.
> - 위 House-style 을 지킬 것. 특히 **주제문은 짧게**, **수치·사실은 소스에 있는 것만**, **없는 사실은 만들지 말 것**.
> - **아이콘·이모지, `--`/`__`/`==`/em-dash/화살표 남발 금지**(AI 티). 강조는 최소한으로.
> - 소스의 구조(Summary/Details/Examples/Gotchas 또는 Problem/Options/Decision)를 그대로 베끼지 말고 읽는 글로 재서술. 코드 예시는 핵심만 발췌.
> - 추가 맥락이 필요하면 공식 문서 등 웹의 사실 기반 자료를 확인해 `## 참고` 섹션에 실존 링크만 단다. 소스노트가 인용한 문서 링크는 그대로 사용 가능.
> - 출력은 위 frontmatter 규격 + 본문. `notion_slug` 는 ascii-kebab. `notion_category` 는 소스 내용 기반 자동 분류, `notion_tags` 는 소스의 topic 태그에서 도출.
> - `content/articles/<slug>.md` 로 저장하고, 생성 원장에 (sourcePath, sourceHash, slug) 를 기록.

## ③ 검토 게이트

- 생성 초안은 `content/articles/` 에 커밋되어 git diff/PR 로 검토 가능.
- 사람이 내용을 확인·수정한 뒤 발행하려면: frontmatter의 `status/needs-review` → **`status/ready-to-publish`** 로 바꾸고, 공개하려면 `notion_published: true` 로 설정.
- 승인 전에는 절대 발행되지 않는다(발행 파이프라인이 `status/ready-to-publish` 만 집기 때문).

## ④ 발행 (기존 파이프라인 재사용)

- `publish-articles.mjs` 가 **두 소스 디렉토리**를 스캔한다:
  1. Obsidian `blog/` (사람이 직접 쓴 글)
  2. Portfolio `content/articles/` (AI 생성 → 사람 승인 글)
- 나머지(Slug 중복 방지, notion_published 반영, ledger)는 동일.

## 생성 원장 (generated-articles.json)

```json
{
  "version": 1,
  "articles": [
    {
      "sourcePath": "knowledge/ef-core-include-split-query-with-projectto.md",
      "sourceHash": "<sha256 앞 12자>",
      "slug": "<notion_slug>",
      "draftPath": "content/articles/<slug>.md",
      "generatedAt": "<ISO8601>",
      "status": "needs-review"
    }
  ]
}
```

발행 원장(`published-articles.json`)과 별개다. 생성 원장 = "무엇을 초안으로 만들었나", 발행 원장 = "무엇을 Notion 에 올렸나".
