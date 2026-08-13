#!/usr/bin/env node
// 생성 대상(article candidate) 탐색기.
//
// Obsidian 의 decisions/ + knowledge/ 노트 중 frontmatter tags 에
// `status/article-candidate` 가 붙은 것을 찾고, 생성 원장과 대조해
// "이번에 생성해야 할 소스" 목록을 출력한다. 선정을 결정적으로 만들어
// AI 생성 단계가 이 목록만 받아 처리하도록 한다.
//
// 사용:
//   node automation/find-article-candidates.mjs           # 사람이 읽는 요약
//   node automation/find-article-candidates.mjs --json     # 기계용 JSON (stdout)
//
// 선택 env: OBSIDIAN_DIR (기본 /workspace/obsidian_claude),
//           GEN_LEDGER_PATH (기본 automation/generated-articles.json)

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

const JSON_OUT = process.argv.includes("--json")
const OBSIDIAN_DIR = process.env.OBSIDIAN_DIR || "/workspace/obsidian_claude"
const GEN_LEDGER_PATH =
  process.env.GEN_LEDGER_PATH || path.join(REPO_ROOT, "automation", "generated-articles.json")

// 선정 태그. 어느 하나라도 있으면 후보. ('status/' 접두어 유무 둘 다 허용)
const CANDIDATE_TAGS = ["article-candidate", "status/article-candidate"]
const SCAN_DIRS = ["decisions", "knowledge"]

// frontmatter 의 tags 리스트만 최소 파싱.
function parseTags(raw) {
  const text = raw.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return []
  const end = text.indexOf("\n---", 4)
  if (end === -1) return []
  const tags = []
  let inTags = false
  for (const line of text.slice(4, end).split("\n")) {
    if (/^tags:\s*$/.test(line)) {
      inTags = true
      continue
    }
    if (inTags) {
      const m = line.match(/^\s*-\s+(.*)$/)
      if (m) {
        tags.push(m[1].trim().replace(/^["']|["']$/g, ""))
        continue
      }
      if (line.trim() !== "") inTags = false
    }
  }
  return tags
}

// frontmatter 이후 본문만 추출.
function parseBody(raw) {
  const text = raw.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return text
  const end = text.indexOf("\n---", 4)
  if (end === -1) return text
  return text.slice(end + 4).replace(/^\n+/, "")
}

// 본문 기준 해시. 태그·날짜 등 frontmatter 변경은 재생성 트리거로 보지 않는다.
function hashContent(raw) {
  return crypto.createHash("sha256").update(parseBody(raw)).digest("hex").slice(0, 12)
}

function hasCandidateTag(tags) {
  return CANDIDATE_TAGS.some((t) => tags.includes(t))
}

function loadLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(GEN_LEDGER_PATH, "utf8"))
    if (!j.articles) j.articles = []
    return j
  } catch {
    return { version: 1, articles: [] }
  }
}

function main() {
  // Obsidian 부재 가드: 이 스크립트의 유일한 소스가 Obsidian 이라,
  // vault 가 없으면 "0건"은 사실이 아니라 착시다. 조용히 넘기지 않고 크게 실패한다.
  if (!fs.existsSync(OBSIDIAN_DIR) || !fs.statSync(OBSIDIAN_DIR).isDirectory()) {
    if (JSON_OUT) {
      process.stdout.write(
        JSON.stringify(
          { error: "obsidian-missing", obsidianDir: OBSIDIAN_DIR, candidates: [], todo: [] },
          null,
          2,
        ) + "\n",
      )
    } else {
      console.error(`\n✖ Obsidian vault 를 찾을 수 없습니다: ${OBSIDIAN_DIR}`)
      console.error(`   소스가 없어 결과(0건)를 신뢰할 수 없습니다. add_repo 로 연결/clone 후 재실행하세요.\n`)
    }
    process.exit(3)
  }

  const ledger = loadLedger()
  const byPath = new Map(ledger.articles.map((a) => [a.sourcePath, a]))

  const candidates = []
  for (const sub of SCAN_DIRS) {
    const dir = path.join(OBSIDIAN_DIR, sub)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue
      const full = path.join(dir, f)
      const raw = fs.readFileSync(full, "utf8")
      if (!hasCandidateTag(parseTags(raw))) continue

      const sourcePath = `${sub}/${f}`
      const sourceHash = hashContent(raw)
      const prev = byPath.get(sourcePath)
      let status
      if (!prev) status = "new"
      else if (prev.sourceHash === sourceHash) status = "skip"
      else status = "needs-regen"

      candidates.push({
        sourcePath,
        sourceHash,
        status,
        existingSlug: prev?.slug ?? null,
        existingDraft: prev?.draftPath ?? null,
      })
    }
  }

  const todo = candidates.filter((c) => c.status !== "skip")

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ candidates, todo }, null, 2) + "\n")
    return
  }

  console.log(`\narticle candidate 탐색 (태그: ${CANDIDATE_TAGS.join(" 또는 ")})`)
  console.log(`  스캔 폴더: ${SCAN_DIRS.join(", ")}  (base: ${OBSIDIAN_DIR})`)
  console.log(`  후보 총계: ${candidates.length}`)
  const g = candidates.filter((c) => c.status === "new").length
  const r = candidates.filter((c) => c.status === "needs-regen").length
  const s = candidates.filter((c) => c.status === "skip").length
  console.log(`   - new(신규 생성):        ${g}`)
  console.log(`   - needs-regen(소스 변경): ${r}`)
  console.log(`   - skip(이미 생성·불변):   ${s}`)
  if (todo.length) {
    console.log(`\n생성 대상 ${todo.length}건:`)
    for (const c of todo) console.log(`   [${c.status}] ${c.sourcePath}  (hash ${c.sourceHash})`)
  } else {
    console.log(`\n생성할 새 후보 없음.`)
  }
  console.log("")
}

main()
