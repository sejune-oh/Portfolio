#!/usr/bin/env node
// 이미 발행된(라이브) 아티클을 content/articles/<slug>.md 기준으로 다시 동기화한다.
// publish-articles.mjs 는 생성 전용(중복 slug 는 skip)이라, 발행 후 본문/속성을
// 고쳤을 때 이 스크립트로 해당 Notion 페이지를 갱신한다.
//
// 대상: published-articles.json 에서 notionPageId 가 있고 source 가 content/articles/ 인 항목.
// 속성(Title/Slug/Date/Category/Tags/Summary/Published)을 갱신하고 본문 블록을 교체한다.
//
// 사용:
//   node automation/update-notion-body.mjs --all [--dry-run]
//   node automation/update-notion-body.mjs <slug> [--dry-run]
//
// 필요 env: NOTION_TOKEN, NOTION_BLOG_DB

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const LEDGER_PATH = path.join(REPO_ROOT, "automation", "published-articles.json")

const DRY_RUN = process.argv.includes("--dry-run")
const ALL = process.argv.includes("--all")
const SLUG_ARG = process.argv.slice(2).find((a) => !a.startsWith("--"))

const TOKEN = process.env.NOTION_TOKEN
const NOTION_API = "https://api.notion.com/v1"
const NOTION_VERSION = "2022-06-28"

const BLOG_PROPS = {
  title: "Title", slug: "Slug", date: "Date",
  category: "Category", tags: "Tags", summary: "Summary", published: "Published",
}

function headers() {
  return {
    accept: "application/json", "Notion-Version": NOTION_VERSION,
    "content-type": "application/json", Authorization: `Bearer ${TOKEN}`,
  }
}

// ── frontmatter + 본문 파서 (publish-articles.mjs 와 동일 규칙) ──
function parseNote(raw) {
  const text = raw.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return { fm: {}, body: text }
  const end = text.indexOf("\n---", 4)
  if (end === -1) return { fm: {}, body: text }
  const fmBlock = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n+/, "")
  const fm = {}
  for (const line of fmBlock.split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/)
    if (kv) fm[kv[1]] = stripQuotes(kv[2].trim())
  }
  return { fm, body }
}
function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))))
    return s.slice(1, -1)
  return s
}

// ── 본문 → Notion 블록 (lib/notionWrite.ts textToBlocks 이식) ──
const FENCE_TO_NOTION = {
  cs: "c#", "c#": "c#", csharp: "c#",
  ts: "typescript", typescript: "typescript", tsx: "typescript",
  js: "javascript", javascript: "javascript", jsx: "javascript",
  sql: "sql", bash: "bash", sh: "shell", shell: "shell", zsh: "shell",
  json: "json", yaml: "yaml", yml: "yaml", xml: "xml", html: "html", css: "css",
  docker: "docker", dockerfile: "docker", diff: "diff", go: "go",
  py: "python", python: "python", rust: "rust", rs: "rust",
  java: "java", kotlin: "kotlin", kt: "kotlin", powershell: "powershell", ps1: "powershell",
}
function fenceToNotion(f) { return FENCE_TO_NOTION[(f || "").trim().toLowerCase()] || "plain text" }
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
  let para = [], inCode = false, codeBuf = [], codeLang = ""
  const flushPara = () => {
    if (para.length) { const t = para.join(" ").trim(); if (t) blocks.push(block("paragraph", t)); para = [] }
  }
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) { blocks.push(block("code", codeBuf.join("\n"), { language: fenceToNotion(codeLang) })); codeBuf = []; codeLang = ""; inCode = false }
      else { flushPara(); inCode = true; codeLang = line.trim().slice(3).trim() }
      continue
    }
    if (inCode) { codeBuf.push(line); continue }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    const li = line.match(/^[-*]\s+(.*)$/)
    if (h) { flushPara(); blocks.push(block(`heading_${h[1].length}`, h[2].trim())) }
    else if (li) { flushPara(); blocks.push(block("bulleted_list_item", li[1].trim())) }
    else if (line.trim() === "") flushPara()
    else para.push(line.trim())
  }
  if (inCode && codeBuf.length) blocks.push(block("code", codeBuf.join("\n"), { language: fenceToNotion(codeLang) }))
  flushPara()
  return blocks
}

function blogProperties(fm) {
  const tags = (fm.notion_tags || "").split(",").map((t) => t.trim()).filter(Boolean)
  const properties = {
    [BLOG_PROPS.title]: { title: rich(fm.notion_title || "") },
    [BLOG_PROPS.slug]: { rich_text: rich(fm.notion_slug || "") },
    [BLOG_PROPS.summary]: { rich_text: rich(fm.notion_summary || "") },
    [BLOG_PROPS.tags]: { multi_select: tags.map((name) => ({ name })) },
    [BLOG_PROPS.published]: { checkbox: String(fm.notion_published).toLowerCase() === "true" },
  }
  properties[BLOG_PROPS.date] = fm.notion_date ? { date: { start: fm.notion_date } } : { date: null }
  properties[BLOG_PROPS.category] = fm.notion_category ? { select: { name: fm.notion_category } } : { select: null }
  return properties
}

async function listChildIds(pageId) {
  const ids = []
  let cursor
  do {
    const url = new URL(`${NOTION_API}/blocks/${pageId}/children`)
    url.searchParams.set("page_size", "100")
    if (cursor) url.searchParams.set("start_cursor", cursor)
    const res = await fetch(url.toString(), { headers: headers(), cache: "no-store" })
    if (!res.ok) throw new Error(`블록 조회 실패 (${res.status})`)
    const j = await res.json()
    for (const b of j.results || []) ids.push(b.id)
    cursor = j.has_more ? j.next_cursor ?? undefined : undefined
  } while (cursor)
  return ids
}
async function appendChildren(pageId, children) {
  for (let i = 0; i < children.length; i += 100) {
    const res = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
      method: "PATCH", headers: headers(), body: JSON.stringify({ children: children.slice(i, i + 100) }),
    })
    if (!res.ok) throw new Error(`본문 추가 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
}
async function deleteBlocks(ids) {
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map((id) =>
      fetch(`${NOTION_API}/blocks/${id}`, { method: "DELETE", headers: headers() })))
  }
}
// 유실 방지: 새 블록 먼저 추가 → 성공 후 옛 블록 삭제.
async function replaceBody(pageId, body) {
  const oldIds = await listChildIds(pageId)
  await appendChildren(pageId, textToBlocks(body))
  await deleteBlocks(oldIds)
}
async function patchProps(pageId, properties) {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH", headers: headers(), body: JSON.stringify({ properties }),
  })
  if (!res.ok) throw new Error(`속성 갱신 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`)
}

async function main() {
  if (!TOKEN) { console.error("✖ NOTION_TOKEN 필요"); process.exit(1) }
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
  let targets = ledger.articles.filter(
    (a) => a.notionPageId && (a.source || "").startsWith("content/articles/")
  )
  if (!ALL) {
    if (!SLUG_ARG) { console.error("✖ slug 인자 또는 --all 필요"); process.exit(1) }
    targets = targets.filter((a) => a.slug === SLUG_ARG)
    if (!targets.length) { console.error(`✖ ledger 에서 slug=${SLUG_ARG} (발행됨) 를 못 찾음`); process.exit(1) }
  }

  console.log(`\n${DRY_RUN ? "[DRY-RUN] " : ""}갱신 대상: ${targets.length}건\n`)
  const done = [], failed = []
  for (const a of targets) {
    const file = path.join(REPO_ROOT, a.source)
    if (!fs.existsSync(file)) { failed.push({ ...a, reason: "md 파일 없음" }); continue }
    const { fm, body } = parseNote(fs.readFileSync(file, "utf8"))
    const blockCount = textToBlocks(body).length
    console.log(`  - ${a.slug}  "${fm.notion_title}"  (본문 ${blockCount} 블록)`)
    if (DRY_RUN) { done.push(a); continue }
    try {
      await patchProps(a.notionPageId, blogProperties(fm))
      await replaceBody(a.notionPageId, body)
      done.push(a)
    } catch (e) { failed.push({ ...a, reason: e.message }) }
  }
  console.log(`\n${DRY_RUN ? "[DRY-RUN] " : ""}완료: ${done.length}, 실패: ${failed.length}`)
  for (const f of failed) console.log(`  ✖ ${f.slug}: ${f.reason}`)
  if (failed.length) process.exit(2)
}

main().catch((e) => { console.error("치명적 오류:", e); process.exit(1) })
