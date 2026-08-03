#!/usr/bin/env node
// Structural validation for feeds/ - hand-rolled on purpose (the tool that guards
// against dependency rot should not itself pull a dependency tree; see
// docs/CONTEXT.md decision 5). schema/model-eol.schema.json is the normative
// artifact; this script enforces the same constraints for CI.
import fs from 'node:fs'
import path from 'node:path'

const FEEDS = path.join(import.meta.dirname, '..', 'feeds')
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
let errors = 0
const err = (file, msg) => {
  console.error(`✗ ${file}: ${msg}`)
  errors++
}

const assertIsoDate = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year >= 0 && year <= 99) date.setUTCFullYear(year)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error(`${label} must be a real calendar date`)
  }
}

const validateDate = (file, label, value) => {
  try {
    assertIsoDate(value, label)
  } catch (error) {
    err(file, error.message)
  }
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
  const modelKeys = new Set(feed.models.flatMap(model => [model?.id, ...(model?.aliases ?? [])].filter(value => typeof value === 'string')))
  for (const [i, m] of feed.models.entries()) {
    const at = `models[${i}]`
    if (!m.id) err(f, `${at}: missing id`)
    for (const key of [m.id, ...(m.aliases ?? [])]) {
      if (seen.has(key)) err(f, `${at}: duplicate id/alias "${key}"`)
      seen.add(key)
    }
    for (const d of ['announced', 'shutdown']) {
      if (m[d] !== undefined) validateDate(f, `${at}: ${d}`, m[d])
    }
    if (m.announced && m.shutdown && m.shutdown < m.announced) err(f, `${at}: shutdown precedes announced`)
    if ((m.announced || m.shutdown) && !(m.source || feed.source)) err(f, `${at}: dated entry needs a source (entry- or feed-level)`)
    if (m.replacement !== undefined) {
      if (typeof m.replacement !== 'string' || !MODEL_ID_PATTERN.test(m.replacement)) {
        err(f, `${at}: replacement must be a grammar-valid model ID`)
      } else if (!modelKeys.has(m.replacement)) {
        err(f, `${at}: replacement does not resolve to an id or alias in this feed: ${m.replacement}`)
      }
    }
    if (m.replacement_options !== undefined) {
      if (!Array.isArray(m.replacement_options) || m.replacement_options.length === 0) {
        err(f, `${at}: replacement_options must be a non-empty array`)
      } else {
        for (const [j, option] of m.replacement_options.entries()) {
          if (typeof option !== 'string' || !MODEL_ID_PATTERN.test(option)) {
            err(f, `${at}.replacement_options[${j}]: must be a grammar-valid model ID`)
          }
        }
      }
      if (m.replacement !== undefined) err(f, `${at}: replacement and replacement_options are mutually exclusive`)
    }
    if (m.replacement_note !== undefined && typeof m.replacement_note !== 'string') {
      err(f, `${at}: replacement_note must be a string`)
    }
    for (const [j, d] of (m.distributions ?? []).entries()) {
      if (!d.via) err(f, `${at}.distributions[${j}]: missing via`)
      for (const field of ['announced', 'shutdown']) {
        if (d[field] !== undefined) validateDate(f, `${at}.distributions[${j}]: ${field}`, d[field])
      }
      if (d.shutdown && !(d.source || m.source || feed.source)) err(f, `${at}.distributions[${j}]: dated distribution needs a source`)
    }
  }
  if (feed.policy?.min_notice_days !== undefined &&
    (!Number.isInteger(feed.policy.min_notice_days) || feed.policy.min_notice_days < 0)) {
    err(f, 'policy.min_notice_days must be a non-negative integer')
  }
  if (!errors) console.log(`✓ ${f}: ${feed.models.length} entries, ${feed.publisher}`)
}

console.log(errors ? `\n${errors} validation error(s)` : 'feeds valid')
process.exit(errors ? 1 : 0)
