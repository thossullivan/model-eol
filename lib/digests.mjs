import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { matchesAnyGlob } from './glob.mjs'

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

export const stableJson = value => JSON.stringify(stableValue(value))

export const sortedJsonDigest = values => {
  const sorted = values.slice().sort((a, b) => {
    const [left, right] = [stableJson(a), stableJson(b)]
    return left < right ? -1 : left > right ? 1 : 0
  })
  return sha256(stableJson(sorted))
}

export const itemDigest = items => sortedJsonDigest(items)

export const activeWaiver = item => item?.waiver?.active === true ? item.waiver : null

export const repoPath = (file, root) => {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute)
  return relative.split(path.sep).join('/').replace(/^\.\//, '')
}

const withoutGenerated = plan => {
  const { generated, ...stable } = plan
  return stable
}

export const planDigest = plan => sha256(stableJson(withoutGenerated(plan)))

export const effectiveEval = (config, commandOverride = null) => ({
  ...config.eval,
  command: typeof commandOverride === 'string' && commandOverride.trim() ? commandOverride : config.eval.command,
})

export const evalConfigDigest = settings => sha256(stableJson({
  command: settings.command ?? null,
  timeout_ms: settings.timeout_ms,
  max_report_bytes: settings.max_report_bytes,
  pass_env: settings.pass_env,
}))

export const evalIdentity = (publisher, id, via) => `${publisher}\0${id}\0${via ?? ''}`

export const feedContext = feedsDir => {
  const records = new Map()
  let files = []
  try {
    files = fs.readdirSync(feedsDir).filter(file => file.endsWith('.json')).sort()
  } catch {
    return records
  }
  for (const file of files) {
    let feed
    try {
      feed = JSON.parse(fs.readFileSync(path.join(feedsDir, file), 'utf8'))
    } catch {
      continue
    }
    if (feed?.spec !== 'model-eol/0.1' || !Array.isArray(feed.models)) continue
    for (const entry of feed.models) {
      for (const key of [entry.id, ...(entry.aliases ?? [])]) {
        if (typeof key === 'string') records.set(`${feed.publisher}\0${key}`, { feed, entry })
      }
    }
  }
  return records
}

export const contextFor = (records, publisher, id, via) => {
  const record = records.get(`${publisher}\0${id}`)
  if (!record) return { announced: null, notes: [], entry: null }
  const distribution = via ? (record.entry.distributions ?? []).find(item => item.via === via) : null
  return {
    announced: distribution ? distribution.announced ?? null : record.entry.announced ?? null,
    notes: [record.feed.note, record.entry.notes].filter(Boolean),
    entry: record.entry,
  }
}

export const ignoredModelIds = (plan, config) => {
  const ignored = new Set(config.ignore.models)
  const ids = new Set()
  for (const item of [...plan.items, ...plan.issues]) {
    if (item.id && (ignored.has(item.id) || ignored.has(item.matched))) ids.add(item.id)
  }
  return ids
}

export const isIgnored = (entry, root, config, ignoredIds) => {
  if (entry.id && ignoredIds.has(entry.id)) return true
  if (entry.id && config.ignore.models.includes(entry.id)) return true
  if (entry.matched && config.ignore.models.includes(entry.matched)) return true
  return matchesAnyGlob(repoPath(entry.file, root), config.ignore.paths)
}

// the capture section reads clocks outside the plan items, so they join the digest that gates body updates
const clockRows = entry => entry
  ? {
      shutdown: entry.shutdown ?? null,
      date_precision: entry.date_precision ?? null,
      distributions: itemDigest((entry.distributions ?? []).map(row => ({ via: row.via, shutdown: row.shutdown ?? null, status: row.status ?? null, date_precision: row.date_precision ?? null }))),
    }
  : null
export const groupDigest = (items, entry) => sha256(stableJson({ items: itemDigest(items), clocks: clockRows(entry) }))

export const modelGroups = (plan, config, root, records, decorate = () => ({})) => {
  const ignoredIds = ignoredModelIds(plan, config)
  const groups = new Map()
  for (const item of plan.items) {
    if (activeWaiver(item)) continue
    if (isIgnored(item, root, config, ignoredIds)) continue
    const via = Object.hasOwn(item, 'requested_via') ? item.requested_via : plan.via
    const key = evalIdentity(item.publisher, item.id, via)
    if (!groups.has(key)) {
      groups.set(key, {
        kind: 'model',
        id: item.id,
        publisher: item.publisher,
        items: [],
        via,
        ...decorate(item.publisher, item.id, via),
        context: contextFor(records, item.publisher, item.id, via),
      })
    }
    groups.get(key).items.push(item)
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => `${a.file}:${a.line}:${a.occurrence}`.localeCompare(`${b.file}:${b.line}:${b.occurrence}`))
    group.feedDigest = groupDigest(group.items, group.context?.entry)
  }
  return [...groups.values()].sort((a, b) => `${a.publisher}/${a.id}`.localeCompare(`${b.publisher}/${b.id}`))
}
