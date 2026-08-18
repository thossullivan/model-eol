import fs from 'node:fs'
import path from 'node:path'

import { assertIsoDate, assertValidFeed } from './validate-feed.mjs'

export { assertIsoDate }

export const BUILTIN_CHANNELS = Object.freeze([
  'azure-ai-foundry',
  'aws-bedrock',
  'vertex-ai',
  'openrouter',
  'litellm',
  'portkey',
  'ai-gateway',
])

export const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const loadFeeds = feedsDir => {
  const feeds = []
  const entries = new Map()
  const keyFiles = new Map()
  const vias = new Set()

  for (const f of fs.readdirSync(feedsDir).filter(f => f.endsWith('.json'))) {
    const file = path.join(feedsDir, f)
    const feed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (feed.spec !== 'model-eol/0.1') {
      throw new Error(`${file}: unsupported feed spec ${JSON.stringify(feed.spec)}; expected "model-eol/0.1"`)
    }
    assertValidFeed(feed, file)
    feeds.push({ ...feed, file })
    for (const m of feed.models ?? []) {
      for (const distribution of m.distributions ?? []) vias.add(distribution.via)
      const record = {
        entry: m,
        publisher: feed.publisher,
        source: m.source ?? feed.source ?? null,
        feedNote: feed.note ?? null,
        policy: feed.policy ?? null,
        generated: feed.generated,
      }
      for (const key of [m.id, ...(m.aliases ?? [])]) {
        const previousFile = keyFiles.get(key)
        if (previousFile) {
          throw new Error(`duplicate feed key "${key}" in ${previousFile} and ${file}`)
        }
        keyFiles.set(key, file)
        entries.set(key, record)
      }
    }
  }

  return {
    feeds,
    entries,
    keys: [...entries.keys()].sort((a, b) => b.length - a.length),
    vias: [...vias].sort(),
  }
}

export const buildModelPattern = keys => {
  if (!keys.length) return null
  // Longest keys first so "o3-deep-research-2025-06-26" wins over alias
  // "o3-deep-research".
  return new RegExp(`(?<![A-Za-z0-9._-])(${keys.map(esc).join('|')})(?![A-Za-z0-9._-])`, 'g')
}

export const daysUntil = (iso, today = new Date()) =>
  Math.ceil((new Date(`${iso}T00:00:00Z`) - today) / 86400000)

const policySafeUntil = (policy, generated) => {
  if (!policy || !Number.isInteger(policy.min_notice_days) || policy.min_notice_days < 0) return null
  const generatedDate = String(generated ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(generatedDate)) return null
  const date = new Date(`${generatedDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  date.setUTCDate(date.getUTCDate() + policy.min_notice_days)
  return date.toISOString().slice(0, 10)
}

export const effectiveShutdown = (entry, via) => {
  if (via) {
    const d = (entry.distributions ?? []).find(d => d.via === via)
    if (d) return {
      date: d.shutdown ?? null,
      via,
      date_precision: d.date_precision ?? null,
      distribution_status: d.status ?? null,
    }
    if (entry.shutdown || entry.announced) {
      return { date: entry.shutdown ?? null, via: 'publisher-fallback', date_precision: entry.date_precision ?? null, distribution_status: null }
    }
    return null
  }
  return entry.shutdown ? { date: entry.shutdown, via: 'publisher', date_precision: entry.date_precision ?? null, distribution_status: null } : null
}

export const lifecycleFor = (entry, options) => {
  const {
    days,
    via,
    today = new Date(),
    policy = options.feed?.policy ?? options.feedPolicy ?? null,
    generated = options.feed?.generated ?? options.feedGenerated ?? null,
  } = options
  const sd = effectiveShutdown(entry, via)
  if (sd) {
    if (sd.distribution_status === 'retired') {
      return {
        status: 'retired',
        shutdown: sd.date,
        date_precision: sd.date_precision,
        distribution_status: sd.distribution_status,
        via: sd.via,
        days: sd.date ? daysUntil(sd.date, today) : null,
        safe_until: sd.date,
      }
    }
    if (sd.date) {
      const remaining = daysUntil(sd.date, today)
      return {
        status: remaining < 0 ? 'retired' : remaining <= days ? 'retiring' : 'scheduled',
        shutdown: sd.date,
        date_precision: sd.date_precision,
        distribution_status: sd.distribution_status,
        via: sd.via,
        days: remaining,
        safe_until: sd.date,
      }
    }
    const distribution = via
      ? (entry.distributions ?? []).find(d => d.via === via)
      : null
    const announced = distribution?.announced ?? (sd.via === 'publisher-fallback' ? entry.announced : null)
    const status = announced ? 'watch' : 'ok'
    return {
      status,
      shutdown: null,
      date_precision: sd.date_precision,
      distribution_status: sd.distribution_status,
      via: sd.via,
      days: null,
      safe_until: status === 'ok' && !entry.announced && !entry.shutdown
        ? policySafeUntil(policy, generated)
        : null,
    }
  }
  if (entry.announced) {
    return { status: 'watch', shutdown: null, date_precision: null, distribution_status: null, via: null, days: null, safe_until: null }
  }
  return {
    status: 'ok',
    shutdown: null,
    date_precision: null,
    distribution_status: null,
    via: null,
    days: null,
    safe_until: policySafeUntil(policy, generated),
  }
}

export const findingFromRef = (ref, options) => {
  const {
    days,
    via,
    today = new Date(),
    policy = ref.policy,
    generated = ref.generated,
  } = options
  const lifecycle = lifecycleFor(ref.entry, {
    days,
    via,
    today,
    policy,
    generated,
  })
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
    date_precision: lifecycle.date_precision ?? null,
    distribution_status: lifecycle.distribution_status ?? null,
    via: lifecycle.via,
    days: lifecycle.days,
    safe_until: lifecycle.safe_until,
    replacement: ref.entry.replacement ?? null,
    replacement_options: ref.entry.replacement_options ?? null,
    replacement_note: ref.entry.replacement_note ?? null,
    threshold_days: days,
  }
}

export const isBad = finding => finding.status === 'retired' || finding.status === 'retiring'
