#!/usr/bin/env node
// Structural validation for feeds/ - hand-rolled on purpose (the tool that guards
// against dependency rot should not itself pull a dependency tree; see
// docs/CONTEXT.md decision 5). schema/model-eol.schema.json is the normative
// artifact; this script enforces the same constraints for CI.
import fs from 'node:fs'
import path from 'node:path'

const FEEDS = path.join(import.meta.dirname, '..', 'feeds')
const DATE = /^\d{4}-\d{2}-\d{2}$/
let errors = 0
const err = (file, msg) => {
  console.error(`✗ ${file}: ${msg}`)
  errors++
}

for (const f of fs.readdirSync(FEEDS).filter(f => f.endsWith('.json'))) {
  let feed
  try {
    feed = JSON.parse(fs.readFileSync(path.join(FEEDS, f), 'utf8'))
  } catch (e) {
    err(f, `invalid JSON: ${e.message}`)
    continue
  }
  if (feed.spec !== 'model-eol/0.1') err(f, `spec must be model-eol/0.1, got ${feed.spec}`)
  if (!feed.publisher) err(f, 'missing publisher')
  if (!feed.generated || Number.isNaN(Date.parse(feed.generated))) err(f, 'missing/invalid generated timestamp')
  if (!Array.isArray(feed.models)) {
    err(f, 'models must be an array')
    continue
  }
  const seen = new Set()
  for (const [i, m] of feed.models.entries()) {
    const at = `models[${i}]`
    if (!m.id) err(f, `${at}: missing id`)
    for (const key of [m.id, ...(m.aliases ?? [])]) {
      if (seen.has(key)) err(f, `${at}: duplicate id/alias "${key}"`)
      seen.add(key)
    }
    for (const d of ['announced', 'shutdown']) {
      if (m[d] !== undefined && !DATE.test(m[d])) err(f, `${at}: ${d} must be YYYY-MM-DD`)
    }
    if (m.announced && m.shutdown && m.shutdown < m.announced) err(f, `${at}: shutdown precedes announced`)
    if ((m.announced || m.shutdown) && !(m.source || feed.source)) err(f, `${at}: dated entry needs a source (entry- or feed-level)`)
    for (const [j, d] of (m.distributions ?? []).entries()) {
      if (!d.via) err(f, `${at}.distributions[${j}]: missing via`)
      if (d.shutdown !== undefined && !DATE.test(d.shutdown)) err(f, `${at}.distributions[${j}]: shutdown must be YYYY-MM-DD`)
      if (d.shutdown && !(d.source || m.source || feed.source)) err(f, `${at}.distributions[${j}]: dated distribution needs a source`)
    }
  }
  if (!errors) console.log(`✓ ${f}: ${feed.models.length} entries, ${feed.publisher}`)
}

console.log(errors ? `\n${errors} validation error(s)` : 'feeds valid')
process.exit(errors ? 1 : 0)
