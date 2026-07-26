import fs from 'node:fs'
import path from 'node:path'

export const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const loadFeeds = feedsDir => {
  const feeds = []
  const entries = new Map()

  for (const f of fs.readdirSync(feedsDir).filter(f => f.endsWith('.json'))) {
    const file = path.join(feedsDir, f)
    const feed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (feed.spec !== 'model-eol/0.1') {
      console.error(`skipping ${f}: unknown spec ${feed.spec}`)
      continue
    }
    feeds.push({ ...feed, file })
    for (const m of feed.models ?? []) {
      const record = {
        entry: m,
        publisher: feed.publisher,
        source: m.source ?? feed.source ?? null,
      }
      for (const key of [m.id, ...(m.aliases ?? [])]) entries.set(key, record)
    }
  }

  return {
    feeds,
    entries,
    keys: [...entries.keys()].sort((a, b) => b.length - a.length),
  }
}

export const buildModelPattern = keys => {
  if (!keys.length) return null
  // Longest keys first so "o3-deep-research-2025-06-26" wins over alias
  // "o3-deep-research".
  return new RegExp(`(?<![A-Za-z0-9._-])(${keys.map(esc).join('|')})(?![A-Za-z0-9_-])`, 'g')
}

export const daysUntil = (iso, today = new Date()) =>
  Math.ceil((new Date(`${iso}T00:00:00Z`) - today) / 86400000)

export const effectiveShutdown = (entry, via) => {
  if (via) {
    const d = (entry.distributions ?? []).find(d => d.via === via)
    if (d?.shutdown) return { date: d.shutdown, via }
    // No distributor-specific date: fall through to the publisher's own,
    // which is the conservative read.
  }
  return entry.shutdown ? { date: entry.shutdown, via: 'publisher' } : null
}

export const lifecycleFor = (entry, { days, via, today = new Date() }) => {
  const sd = effectiveShutdown(entry, via)
  if (sd) {
    const remaining = daysUntil(sd.date, today)
    return {
      status: remaining < 0 ? 'retired' : remaining <= days ? 'retiring' : 'scheduled',
      shutdown: sd.date,
      via: sd.via,
      days: remaining,
    }
  }
  if (entry.announced) {
    return { status: 'watch', shutdown: null, via: null, days: null }
  }
  return { status: 'ok', shutdown: null, via: null, days: null }
}

export const findingFromRef = (ref, { days, via, today = new Date() }) => {
  const lifecycle = lifecycleFor(ref.entry, { days, via, today })
  return {
    file: ref.file,
    line: ref.line,
    matched: ref.matched,
    id: ref.entry.id,
    publisher: ref.publisher,
    usage: ref.usage,
    resolved_provider: ref.resolved_provider,
    confidence: ref.confidence,
    status: lifecycle.status,
    shutdown: lifecycle.shutdown,
    via: lifecycle.via,
    days: lifecycle.days,
    replacement: ref.entry.replacement ?? null,
  }
}

export const isBad = finding => finding.status === 'retired' || finding.status === 'retiring'
