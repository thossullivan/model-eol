import crypto from 'node:crypto'
import path from 'node:path'

export { matchesAnyGlob, matchesGlob } from '../../lib/glob.mjs'

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
  const sorted = values.slice().sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
  return sha256(stableJson(sorted))
}

const safeSegment = value => {
  const result = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return result || 'model'
}

export const slugFor = id => {
  const slug = safeSegment(id).slice(0, 40).replace(/^-+|-+$/g, '')
  return slug || 'model'
}

export const branchFor = (publisher, id, via = null) =>
  `model-eol/${safeSegment(publisher)}${via ? `/${safeSegment(via)}` : ''}/${slugFor(id)}-${sha256(String(id)).slice(0, 8)}`

export const daysRemaining = (shutdown, now = new Date()) => {
  if (!shutdown) return null
  return Math.ceil((new Date(`${shutdown}T00:00:00Z`) - now) / 86400000)
}

export const repoPath = (file, root) => {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute)
  return relative.split(path.sep).join('/').replace(/^\.\//, '')
}

export const metadataLine = metadata => `<!-- model-eol ${JSON.stringify(metadata).replaceAll('-->', '\\u002d\\u002d\\u003e')} -->`

export const hasMetadataMarker = body => String(body ?? '').includes('<!-- model-eol')

export const parseMetadata = body => {
  const firstLine = String(body ?? '').split(/\r?\n/, 1)[0]
  const match = firstLine.match(/^<!-- model-eol (\{.*\}) -->$/)
  if (!match) return null
  try {
    const metadata = JSON.parse(match[1])
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
    if (metadata.schema !== 'model-eol.bot/0.1') return null
    if (typeof metadata.id !== 'string' || !metadata.id) return null
    if (typeof metadata.publisher !== 'string' || !metadata.publisher) return null
    if (!Object.hasOwn(metadata, 'shutdown') || (metadata.shutdown !== null && typeof metadata.shutdown !== 'string')) return null
    if (metadata.via !== undefined && metadata.via !== null && typeof metadata.via !== 'string') return null
    if (metadata.replacement !== undefined && metadata.replacement !== null && typeof metadata.replacement !== 'string') return null
    if (metadata.replacement_options !== undefined && (!Array.isArray(metadata.replacement_options) || metadata.replacement_options.some(option => typeof option !== 'string'))) return null
    if (metadata.replacement_note !== undefined && metadata.replacement_note !== null && typeof metadata.replacement_note !== 'string') return null
    if (metadata.base_sha !== undefined && metadata.base_sha !== null && (typeof metadata.base_sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(metadata.base_sha))) return null
    if (metadata.stale_closed !== undefined && metadata.stale_closed !== true) return null
    if (typeof metadata.feed_digest !== 'string' || !metadata.feed_digest) return null
    if (!Object.hasOwn(metadata, 'head_sha') || (metadata.head_sha !== null && typeof metadata.head_sha !== 'string')) return null
    if (metadata.channel !== undefined && (typeof metadata.channel !== 'string' || !metadata.channel)) return null
    return metadata
  } catch {
    return null
  }
}

export const itemDigest = items => sortedJsonDigest(items)

const entityMap = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['`', '&#96;'],
  ['\\', '&#92;'],
  ['[', '&#91;'],
  [']', '&#93;'],
  ['(', '&#40;'],
  [')', '&#41;'],
  ['#', '&#35;'],
  ['*', '&#42;'],
  ['_', '&#95;'],
  ['~', '&#126;'],
  ['!', '&#33;'],
])

export const markdownText = value => String(value ?? '')
  .replaceAll('\r\n', '\n')
  .replaceAll('\r', '\n')
  .replace(/[&<>`\\[\]()#*_~!]/g, character => entityMap.get(character))
  .split('\n')
  .map(line => line.replace(/^(\s*)([-+>]\s|\d+\.\s)/, '$1&#45; '))
  .join('\n')

export const markdownCode = value => `\`${markdownText(value)}\``

export const markdownLink = (label, value) => {
  const text = String(value ?? '')
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return markdownText(text)
    const href = url.toString().replaceAll('\\', '%5C').replaceAll('(', '%28').replaceAll(')', '%29')
    return `[${markdownText(label)}](${href})`
  } catch {
    return markdownText(text)
  }
}

export const markdownFenceText = value => String(value ?? '').replaceAll('`', '')
