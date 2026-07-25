#!/usr/bin/env node
// model-eol reference checker - zero dependencies.
//
// Scans source/config files for model IDs that appear in the loaded feeds and
// fails when one is retired or retiring within the threshold. The point is the
// feed format (see SPEC.md); this checker is the smallest useful consumer of it.
//
// usage:
//   node check.mjs [paths...] [--days N] [--feeds DIR] [--via DISTRIBUTOR] [--json] [--include-docs]
//
// exit codes: 0 = clear · 1 = retired or retiring within threshold · 2 = usage error

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const has = name => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

const DAYS = Number(flag('days', '90'))
const FEEDS_DIR = flag('feeds', path.join(import.meta.dirname, 'feeds'))
const VIA = flag('via', null) // e.g. azure-ai-foundry, aws-bedrock
const AS_JSON = has('json')
const INCLUDE_DOCS = has('include-docs')
const targets = args.length ? args : ['.']

if (Number.isNaN(DAYS)) {
  console.error('--days must be a number')
  process.exit(2)
}

// --- load feeds ---------------------------------------------------------------
const entries = new Map() // matched string (id or alias) -> { entry, publisher }
for (const f of fs.readdirSync(FEEDS_DIR).filter(f => f.endsWith('.json'))) {
  const feed = JSON.parse(fs.readFileSync(path.join(FEEDS_DIR, f), 'utf8'))
  if (feed.spec !== 'model-eol/0.1') {
    console.error(`skipping ${f}: unknown spec ${feed.spec}`)
    continue
  }
  for (const m of feed.models ?? []) {
    for (const key of [m.id, ...(m.aliases ?? [])]) entries.set(key, { entry: m, publisher: feed.publisher })
  }
}
if (entries.size === 0) {
  console.error(`no feed entries loaded from ${FEEDS_DIR}`)
  process.exit(2)
}

// Longest keys first so "o3-deep-research-2025-06-26" wins over alias "o3-deep-research".
const keys = [...entries.keys()].sort((a, b) => b.length - a.length)
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pattern = new RegExp(`(?<![A-Za-z0-9._-])(${keys.map(esc).join('|')})(?![A-Za-z0-9_-])`, 'g')

// --- scan ---------------------------------------------------------------------
const CODE_EXT = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml', '.env', '.ini', '.cfg', '.sh', '.rb', '.go', '.java', '.cs'])
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.astro'])

const files = []
const walk = p => {
  const st = fs.statSync(p)
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(p))) return
    for (const f of fs.readdirSync(p)) walk(path.join(p, f))
    return
  }
  const ext = path.extname(p)
  if (CODE_EXT.has(ext) || (INCLUDE_DOCS && DOC_EXT.has(ext))) files.push(p)
}
for (const t of targets) walk(t)

const today = new Date()
const daysUntil = iso => Math.ceil((new Date(`${iso}T00:00:00Z`) - today) / 86400000)

const effectiveShutdown = entry => {
  if (VIA) {
    const d = (entry.distributions ?? []).find(d => d.via === VIA)
    if (d?.shutdown) return { date: d.shutdown, via: VIA }
    // No distributor-specific date: fall through to the publisher's own,
    // which is the conservative read (Azure/Bedrock never retire EARLIER
    // than announced without their own entry).
  }
  return entry.shutdown ? { date: entry.shutdown, via: 'publisher' } : null
}

const findings = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(line)) !== null) {
      const { entry, publisher } = entries.get(m[1])
      const sd = effectiveShutdown(entry)
      let status = 'ok'
      let days = null
      if (sd) {
        days = daysUntil(sd.date)
        status = days < 0 ? 'retired' : days <= DAYS ? 'retiring' : 'scheduled'
      } else if (entry.announced) {
        status = 'watch'
      }
      findings.push({
        file, line: i + 1, matched: m[1], id: entry.id, publisher,
        status, shutdown: sd?.date ?? null, via: sd?.via ?? null, days,
        replacement: entry.replacement ?? null,
      })
    }
  }
}

// --- report --------------------------------------------------------------------
const bad = findings.filter(f => f.status === 'retired' || f.status === 'retiring')
if (AS_JSON) {
  console.log(JSON.stringify({ threshold_days: DAYS, distributor: VIA, findings }, null, 2))
} else {
  if (findings.length === 0) {
    console.log(`model-eol: no tracked model IDs found in ${files.length} files`)
  }
  for (const f of findings) {
    const where = `${f.file}:${f.line}`
    const tail =
      f.status === 'retired' ? `RETIRED ${f.shutdown} (${-f.days} days ago)${f.replacement ? ` -> ${f.replacement}` : ''}` :
      f.status === 'retiring' ? `RETIRES ${f.shutdown} (${f.days} days)${f.replacement ? ` -> ${f.replacement}` : ''}` :
      f.status === 'scheduled' ? `scheduled ${f.shutdown} (${f.days} days, outside --days ${DAYS})` :
      f.status === 'watch' ? 'deprecation announced, no shutdown date yet' :
      'no retirement scheduled'
    const mark = f.status === 'retired' ? '✗' : f.status === 'retiring' ? '!' : '·'
    console.log(`${mark} ${where}  ${f.matched}  ${tail}${f.via && f.via !== 'publisher' ? `  [via ${f.via}]` : ''}`)
  }
  if (bad.length) console.log(`\nmodel-eol: ${bad.length} finding(s) at or past the ${DAYS}-day threshold`)
}
process.exit(bad.length ? 1 : 0)
