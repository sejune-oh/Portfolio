#!/usr/bin/env node
// Obsidian(자료 소스) → Portfolio Notion Blog DB(발행) 자동 파이프라인.
//
// 절차:
//   1) Obsidian vault 의 blog/*.md 중 `status/ready-to-publish` 태그가 붙은 노트를 찾는다.
//   2) frontmatter(notion_*)를 Notion Blog DB 필드로 매핑한다.
//   3) 중복 방지: 기존 Notion Blog DB 의 Slug + 로컬 ledger 를 대조해 이미 있으면 skip.
//   4) Notion API 로 페이지 생성(속성 + 본문 블록). published 는 frontmatter 값을 따른다.
//   5) ledger(automation/published-articles.json)에 발행 이력을 기록한다.
//
// 사용:
//   node automation/publish-articles.mjs            # 실제 발행
//   node automation/publish-articles.mjs --dry-run  # 무엇을 발행할지 출력만(쓰기 없음)
//
// 필요한 환경변수: NOTION_TOKEN, NOTION_BLOG_DB
// 선택 환경변수: OBSIDIAN_DIR (기본 /workspace/obsidian_claude)

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

const DRY_RUN = process.argv.includes("--dry-run")
const OBSIDIAN_DIR = process.env.OBSIDIAN_DIR || "/workspace/obsidian_claude"
const BLOG_DIR = path.join(OBSIDIAN_DIR, "blog")
const LEDGER_PATH =
  process.env.LEDGER_PATH || path.join(REPO_ROOT, "automation", "published-articles.json")

const TOKEN = process.env.NOTION_TOKEN
const BLOG_DB = process.env.NOTION_BLOG_DB

const NOTION_API = "https://api.notion.com/v1"
const NOTION_VERSION = "2022-06-28"
const READY_TAG = "status/ready-to-publish"

// ── Notion Blog DB 속성명 (lib/postsData.ts 의 BLOG_PROPS 와 반드시 일치) ──
const BLOG_PROPS = {
  title: "Title",
  slug: "Slug",
  date: "Date",
  category: "Category",
  tags: "Tags",
  summary: "Summary",
  published: "Published",
}

function headers() {
  return {
    accept: "application/json",
    "Notion-Version": NOTION_VERSION,
    "content-type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  }
}

// ── frontmatter 파서 (필요한 필드만 최소 파싱) ────────────────────
// 첫 줄 '---' ~ 다음 '---' 사이를 frontmatter 로 보고, 나머지를 본문으로 본다.
function parseNote(raw) {
  const text = raw.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return { fm: {}, tags: [], body: text }
  const end = text.indexOf("\n---", 4)
  if (end === -1) return { fm: {}, tags: [], body: text }
  const fmBlock = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n+/, "") // '\n---' 다음 본문

  const fm = {}
  const tags = []
  const lines = fmBlock.split("\n")
  let inTags = false
  for (const line of lines) {
    if (/^tags:\s*$/.test(line)) {
      inTags = true
      continue
    }
    if (inTags) {
      const m = line.match(/^\s*-\s+(.*)$/)
      if (m) {
        tags.push(stripQuotes(m[1].trim()))
        continue
      }
      inTags = false // 리스트 종료
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/)
    if (kv) fm[kv[1]] = stripQuotes(kv[2].trim())
  }
  return { fm, tags, body }
}

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

// ── 본문 텍스트 → Notion 블록 (lib/notionWrite.ts textToBlocks 이식) ──
const FENCE_TO_NOTION = {
  cs: "c#", "c#": "c#", csharp: "c#",
  ts: "typescript", typescript: "typescript", tsx: "typescript",
  js: "javascript", javascript: "javascript", jsx: "javascript",
  sql: "sql",
  bash: "bash", sh: "shell", shell: "shell", zsh: "shell",
  json: "json", yaml: "yaml", yml: "yaml",
  xml: "xml", html: "html", css: "css",
  docker: "docker", dockerfile: "docker",
  diff: "diff", go: "go", py: "python", python: "python",
  rust: "rust", rs: "rust", java: "java", kotlin: "kotlin", kt: "kotlin",
}
function fenceToNotion(fence) {
  return FENCE_TO_NOTION[(fence || "").trim().toLowerCase()] || "plain text"
}

function rich(content) {
  const text = content ?? ""
  if (!text) return []
  const chunks = []
  for (let i = 0; i < text.length; i += 2000) chunks.push(text.slice(i, i + 2000))
  return chunks.map((c) => ({ type: "text", text: { content: c } }))
}
function block(type, content, extra = {}) {
  return { object: "block", type, [type]: { rich_text: rich(content), ...extra } }
}
function textToBlocks(src) {
  const lines = (src ?? "").replace(/\r\n/g, "\n").split("\n")
  const blocks = []
  let para = []
  let inCode = false
  let codeBuf = []
  let codeLang = ""
  const flushPara = () => {
    if (para.length) {
      const t = para.join(" ").trim()
      if (t) blocks.push(block("paragraph", t))
      para = []
    }
  }
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        blocks.push(block("code", codeBuf.join("\n"), { language: fenceToNotion(codeLang) }))
        codeBuf = []
        codeLang = ""
        inCode = false
      } else {
        flushPara()
        inCode = true
        codeLang = line.trim().slice(3).trim()
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const li = line.match(/^[-*]\s+(.*)$/)
    if (h) {
      flushPara()
      blocks.push(block(`heading_${h[1].length}`, h[2].trim()))
    } else if (li) {
      flushPara()
      blocks.push(block("bulleted_list_item", li[1].trim()))
    } else if (line.trim() === "") {
      flushPara()
    } else {
      para.push(line.trim())
    }
  }
  if (inCode && codeBuf.length) {
    blocks.push(block("code", codeBuf.join("\n"), { language: fenceToNotion(codeLang) }))
  }
  flushPara()
  return blocks
}

// ── ledger ────────────────────────────────────────────────────────
function loadLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
    if (!j.articles) j.articles = []
    return j
  } catch {
    return { version: 1, articles: [] }
  }
}
function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true })
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n")
}

// ── Notion 호출 ────────────────────────────────────────────────────
async function slugExistsInNotion(slug) {
  const res = await fetch(`${NOTION_API}/databases/${BLOG_DB}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      filter: { property: BLOG_PROPS.slug, rich_text: { equals: slug } },
      page_size: 1,
    }),
  })
  if (!res.ok) throw new Error(`Notion query 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  return (json.results || []).length > 0
}

function blogProperties(a) {
  const properties = {
    [BLOG_PROPS.title]: { title: rich(a.title) },
    [BLOG_PROPS.slug]: { rich_text: rich(a.slug) },
    [BLOG_PROPS.summary]: { rich_text: rich(a.summary) },
    [BLOG_PROPS.tags]: { multi_select: a.tags.map((name) => ({ name })) },
    [BLOG_PROPS.published]: { checkbox: a.published },
  }
  properties[BLOG_PROPS.date] = a.date ? { date: { start: a.date } } : { date: null }
  properties[BLOG_PROPS.category] = a.category ? { select: { name: a.category } } : { select: null }
  return properties
}

async function createBlogPage(a) {
  const createRes = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { database_id: BLOG_DB },
      properties: blogProperties(a),
    }),
  })
  if (!createRes.ok) {
    throw new Error(`페이지 생성 실패 (${createRes.status}): ${(await createRes.text()).slice(0, 300)}`)
  }
  const page = await createRes.json()
  const children = textToBlocks(a.body)
  for (let i = 0; i < children.length; i += 100) {
    const chunk = children.slice(i, i + 100)
    const res = await fetch(`${NOTION_API}/blocks/${page.id}/children`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ children: chunk }),
    })
    if (!res.ok) throw new Error(`본문 저장 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  return page.id
}

// ── 메인 ────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN || !BLOG_DB) {
    console.error("✖ NOTION_TOKEN / NOTION_BLOG_DB 환경변수가 필요합니다.")
    process.exit(1)
  }
  if (!fs.existsSync(BLOG_DIR)) {
    console.error(`✖ Obsidian blog 폴더를 찾을 수 없습니다: ${BLOG_DIR}`)
    process.exit(1)
  }

  const ledger = loadLedger()
  const ledgerSlugs = new Set(ledger.articles.map((x) => x.slug))

  const files = fs
    .readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(BLOG_DIR, f))

  const candidates = []
  for (const file of files) {
    const { fm, tags, body } = parseNote(fs.readFileSync(file, "utf8"))
    if (!tags.includes(READY_TAG)) continue
    const slug = fm.notion_slug || ""
    const title = fm.notion_title || ""
    if (!slug || !title) {
      console.warn(`⚠ 건너뜀 (slug/title 없음): ${path.basename(file)}`)
      continue
    }
    candidates.push({
      source: path.relative(OBSIDIAN_DIR, file),
      slug,
      title,
      date: fm.notion_date || "",
      category: fm.notion_category || "",
      tags: (fm.notion_tags || "").split(",").map((t) => t.trim()).filter(Boolean),
      summary: fm.notion_summary || "",
      published: String(fm.notion_published).toLowerCase() === "true",
      body,
    })
  }

  console.log(`\n발행 후보 (ready-to-publish): ${candidates.length}건`)
  const results = { published: [], skipped: [], failed: [] }

  for (const a of candidates) {
    // 1) ledger 중복
    if (ledgerSlugs.has(a.slug)) {
      results.skipped.push({ ...a, reason: "ledger 에 이미 기록됨" })
      continue
    }
    // 2) Notion 중복
    let exists = false
    try {
      exists = await slugExistsInNotion(a.slug)
    } catch (e) {
      results.failed.push({ ...a, reason: e.message })
      continue
    }
    if (exists) {
      // Notion 엔 있는데 ledger 엔 없던 경우 → ledger 를 보정(발행은 skip).
      ledger.articles.push({
        slug: a.slug,
        source: a.source,
        title: a.title,
        notionPageId: null,
        publishedAt: null,
        note: "이미 Notion 에 존재하여 ledger 보정",
      })
      ledgerSlugs.add(a.slug)
      results.skipped.push({ ...a, reason: "Notion 에 동일 slug 존재" })
      continue
    }

    // 3) 발행
    if (DRY_RUN) {
      results.published.push({ ...a, notionPageId: "(dry-run)" })
      continue
    }
    try {
      const id = await createBlogPage(a)
      ledger.articles.push({
        slug: a.slug,
        source: a.source,
        title: a.title,
        notionPageId: id,
        publishedAt: new Date().toISOString(),
      })
      ledgerSlugs.add(a.slug)
      results.published.push({ ...a, notionPageId: id })
    } catch (e) {
      results.failed.push({ ...a, reason: e.message })
    }
  }

  if (!DRY_RUN) saveLedger(ledger)

  // ── 요약 출력 ──
  const tag = DRY_RUN ? "[DRY-RUN] " : ""
  console.log(`\n${tag}결과 요약`)
  console.log(`  ✔ 발행: ${results.published.length}`)
  for (const a of results.published) {
    console.log(`     - ${a.slug}  (${a.title})  published=${a.published}  page=${a.notionPageId}`)
  }
  console.log(`  ⏭ 스킵(중복): ${results.skipped.length}`)
  for (const a of results.skipped) console.log(`     - ${a.slug}  (${a.reason})`)
  console.log(`  ✖ 실패: ${results.failed.length}`)
  for (const a of results.failed) console.log(`     - ${a.slug}  (${a.reason})`)
  console.log("")

  if (results.failed.length > 0) process.exit(2)
}

main().catch((e) => {
  console.error("치명적 오류:", e)
  process.exit(1)
})
