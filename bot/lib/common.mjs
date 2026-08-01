import crypto from 'node:crypto'
import path from 'node:path'

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

export const branchFor = (publisher, id) =>
  `model-eol/${safeSegment(publisher)}/${slugFor(id)}-${sha256(String(id)).slice(0, 8)}`

export const daysRemaining = (shutdown, now = new Date()) => {
  if (!shutdown) return null
  return Math.ceil((new Date(`${shutdown}T00:00:00Z`) - now) / 86400000)
}

export const repoPath = (file, root) => {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute)
  return relative.split(path.sep).join('/').replace(/^\.\//, '')
}

const globRegex = pattern => {
  let source = ''
  const value = String(pattern).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '*' && value[i + 1] === '*') {
      if (value[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i++
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export const matchesGlob = (file, pattern) => globRegex(pattern).test(file)

export const matchesAnyGlob = (file, patterns = []) => patterns.some(pattern => matchesGlob(file, pattern))

export const metadataLine = metadata => `<!-- model-eol ${JSON.stringify(metadata)} -->`

export const parseMetadata = body => {
  const firstLine = String(body ?? '').split(/\r?\n/, 1)[0]
  const match = firstLine.match(/^<!-- model-eol (\{.*\}) -->$/)
  if (!match) return null
  try {
    const metadata = JSON.parse(match[1])
    return metadata?.schema === 'model-eol.bot/0.1' && typeof metadata.id === 'string'
      ? metadata
      : null
  } catch {
    return null
  }
}

export const itemDigest = items => sortedJsonDigest(items)
