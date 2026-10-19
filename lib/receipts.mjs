import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const EVAL_RESULTS_SCHEMA = 'model-eol.eval/0.1'
export const FEED_REFRESH_RECEIPT_SCHEMA = 'model-eol/feed-refresh-receipt@0.1'
export const RELEASE_RECEIPT_SCHEMA = 'model-eol/npm-release-result@0.2'
export const VERIFICATION_SCHEMA = 'model-eol/verification@0.1'

export const SHA_PATTERN = /^[0-9a-f]{40,64}$/
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/
export const RELEASE_VERSION_PATTERN = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const FEED_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.json$/

const EVAL_STATUSES = new Set(['pass', 'fail', 'timeout'])

export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const assertExactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly ${wanted.join(', ')}; got ${actual.join(', ')}`)
  }
}

export const assertInstant = (value, label) => {
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value)
    : null
  const parsed = match ? new Date(value) : null
  if (!match || !Number.isFinite(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
    || parsed.getUTCHours() !== Number(match[4])
    || parsed.getUTCMinutes() !== Number(match[5])
    || parsed.getUTCSeconds() !== Number(match[6])) {
    throw new Error(`${label} must be a valid UTC ISO 8601 instant`)
  }
  return value
}

export const assertSha = (value, label) => {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new Error(`${label} must be a 40-64 character lowercase hexadecimal Git commit`)
  return value
}

export const assertDigest = (value, label) => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw new Error(`${label} must be a 64 character lowercase hexadecimal SHA-256 digest`)
  return value
}

export const assertHttpsUrl = (value, label) => {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`${label} must be a valid HTTPS URL`)
  return parsed.toString()
}

export const assertReleaseVersion = value => {
  if (typeof value !== 'string' || !RELEASE_VERSION_PATTERN.test(value)) throw new Error(`release version must be an exact stable 0.x version, got ${value}`)
  return value
}

export const assertSha512Integrity = (value, label = 'integrity') => {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new Error(`${label} must be an npm sha512 Subresource Integrity value`)
  }
  const encoded = value.slice('sha512-'.length)
  let digest
  try {
    digest = Buffer.from(encoded, 'base64')
  } catch {
    digest = Buffer.alloc(0)
  }
  if (digest.length !== 64 || digest.toString('base64') !== encoded) {
    throw new Error(`${label} must contain one canonical 64-byte SHA-512 digest`)
  }
  return value
}

export const sha512Integrity = bytes => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

export const hashFeedFiles = feedDir => {
  const names = fs.readdirSync(feedDir).filter(name => name.endsWith('.json')).sort()
  if (!names.length) throw new Error(`no JSON feeds found in ${feedDir}`)
  return names.map(name => ({
    path: `feeds/${name}`,
    sha256: sha256(fs.readFileSync(path.join(feedDir, name))),
  }))
}

export const hashFeedDirectory = repoDir => hashFeedFiles(path.join(path.resolve(repoDir), 'feeds'))

export function assertValidFeedRefreshReceipt(receipt) {
  if (!isPlainObject(receipt)) throw new Error('feed refresh receipt must be a JSON object')
  const keys = ['schema', 'state', 'changed', 'pending', 'checked_at', 'refresh_run', 'refresh_commit', 'feeds']
  if (receipt.state === 'pending') keys.push('pending_pr')
  assertExactKeys(receipt, keys, 'feed refresh receipt')
  if (receipt.schema !== FEED_REFRESH_RECEIPT_SCHEMA) throw new Error(`unsupported feed refresh receipt schema ${receipt.schema}`)
  if (receipt.state !== 'clean' && receipt.state !== 'pending') throw new Error('receipt state must be clean or pending')
  if (typeof receipt.changed !== 'boolean' || typeof receipt.pending !== 'boolean') throw new Error('receipt changed and pending fields must be boolean')
  if (receipt.changed !== (receipt.state === 'pending') || receipt.pending !== (receipt.state === 'pending')) {
    throw new Error('receipt changed/pending fields do not agree with receipt state')
  }
  assertInstant(receipt.checked_at, 'checked_at')
  assertHttpsUrl(receipt.refresh_run, 'refresh_run')
  assertSha(receipt.refresh_commit, 'refresh_commit')
  if (receipt.state === 'pending') assertHttpsUrl(receipt.pending_pr, 'pending_pr')
  if (!Array.isArray(receipt.feeds) || !receipt.feeds.length) throw new Error('receipt feeds must be a non-empty array')
  const priorPaths = new Set()
  for (const [index, feed] of receipt.feeds.entries()) {
    if (!isPlainObject(feed)) throw new Error(`receipt feeds[${index}] must be an object`)
    assertExactKeys(feed, ['path', 'sha256'], `receipt feeds[${index}]`)
    if (typeof feed.path !== 'string' || !feed.path.startsWith('feeds/') || !FEED_NAME_PATTERN.test(feed.path.slice('feeds/'.length))) {
      throw new Error(`receipt feeds[${index}].path must identify one feeds/*.json file`)
    }
    if (priorPaths.has(feed.path)) throw new Error(`receipt contains duplicate feed path ${feed.path}`)
    priorPaths.add(feed.path)
    if (typeof feed.sha256 !== 'string' || !DIGEST_PATTERN.test(feed.sha256)) throw new Error(`receipt ${feed.path} has an invalid SHA-256 digest`)
  }
  const sorted = [...receipt.feeds].sort((left, right) => left.path.localeCompare(right.path))
  if (JSON.stringify(sorted) !== JSON.stringify(receipt.feeds)) throw new Error('receipt feeds must be sorted by path')
  return receipt
}

export function assertValidReleaseReceipt(receipt) {
  if (!isPlainObject(receipt)) throw new Error('release receipt must be a JSON object')
  if (typeof receipt.released !== 'boolean') throw new Error('release receipt released must be boolean')
  assertExactKeys(receipt, receipt.released
    ? ['schema', 'released', 'source_commit', 'version', 'tag', 'release_commit', 'registry_integrity']
    : ['schema', 'released', 'source_commit'], 'release receipt')
  if (receipt.schema !== RELEASE_RECEIPT_SCHEMA) throw new Error(`unsupported release receipt schema ${receipt.schema}`)
  assertSha(receipt.source_commit, 'source_commit')
  if (receipt.released) {
    assertReleaseVersion(receipt.version)
    if (receipt.tag !== `v${receipt.version}`) throw new Error(`release receipt tag ${receipt.tag} does not match version ${receipt.version}`)
    assertSha(receipt.release_commit, 'release_commit')
    assertSha512Integrity(receipt.registry_integrity, 'registry_integrity')
  }
  return receipt
}

export function assertValidEvalResults(artifact) {
  if (!isPlainObject(artifact)) throw new Error('eval results must be a JSON object')
  assertExactKeys(artifact, ['schema', 'generated', 'base_sha', 'plan_digest', 'eval_config_digest', 'configured', 'results'], 'eval results')
  if (artifact.schema !== EVAL_RESULTS_SCHEMA) throw new Error(`unsupported eval results schema ${artifact.schema}`)
  assertInstant(artifact.generated, 'generated')
  assertSha(artifact.base_sha, 'base_sha')
  assertDigest(artifact.plan_digest, 'plan_digest')
  assertDigest(artifact.eval_config_digest, 'eval_config_digest')
  if (typeof artifact.configured !== 'boolean') throw new Error('configured must be boolean')
  if (!Array.isArray(artifact.results)) throw new Error('results must be an array')
  if (!artifact.configured && artifact.results.length) throw new Error('results must be empty when configured is false')
  for (const [index, result] of artifact.results.entries()) {
    const label = `results[${index}]`
    if (!isPlainObject(result)) throw new Error(`${label} must be an object`)
    assertExactKeys(result, ['publisher', 'id', 'via', 'feed_digest', 'status', 'exit_code', 'report'], label)
    if (typeof result.publisher !== 'string' || !result.publisher || typeof result.id !== 'string' || !result.id) throw new Error(`${label} identity is malformed`)
    if (result.via !== null && typeof result.via !== 'string') throw new Error(`${label} clock is malformed`)
    assertDigest(result.feed_digest, `${label}.feed_digest`)
    if (!EVAL_STATUSES.has(result.status)) throw new Error(`${label} has an invalid status`)
    if (result.exit_code !== null && !Number.isSafeInteger(result.exit_code)) throw new Error(`${label} has an invalid exit code`)
    if (result.status === 'pass' && result.exit_code !== 0) throw new Error(`${label} passes with a non-zero exit code`)
    if (result.report !== null && typeof result.report !== 'string') throw new Error(`${label} has an invalid report`)
  }
  return artifact
}

export const verificationResult = claims => {
  const statuses = claims.map(claim => claim.status)
  if (statuses.includes('mismatch')) return 'mismatch'
  const applicable = statuses.filter(status => status !== 'not-applicable')
  return applicable.length && applicable.every(status => status === 'verified') ? 'verified' : 'partial'
}

export function assertValidVerification(document) {
  if (!isPlainObject(document)) throw new Error('verification must be a JSON object')
  if (document.schema !== VERIFICATION_SCHEMA) throw new Error(`unsupported verification schema ${document.schema}`)
  const info = document.receipt
  if (!isPlainObject(info)) throw new Error('verification receipt must be an object')
  const refresh = info.schema === FEED_REFRESH_RECEIPT_SCHEMA
  const release = info.schema === RELEASE_RECEIPT_SCHEMA
  for (const field of ['state', 'checked_at', 'pending_pr']) {
    if (!refresh && Object.hasOwn(info, field)) throw new Error(`verification receipt.${field} applies only to ${FEED_REFRESH_RECEIPT_SCHEMA} receipts`)
  }
  if (!release && Object.hasOwn(info, 'released')) throw new Error(`verification receipt.released applies only to ${RELEASE_RECEIPT_SCHEMA} receipts`)
  if (release && typeof info.released !== 'boolean') throw new Error('verification receipt.released must be boolean for a release receipt')
  if (refresh) {
    if (info.state !== 'clean' && info.state !== 'pending') throw new Error('verification receipt.state must be clean or pending')
    assertInstant(info.checked_at, 'verification receipt.checked_at')
    if ((info.state === 'pending') !== Object.hasOwn(info, 'pending_pr')) throw new Error('verification receipt.pending_pr must be present exactly when state is pending')
    if (info.state === 'pending') assertHttpsUrl(info.pending_pr, 'verification receipt.pending_pr')
  }
  if (!Array.isArray(document.claims)) throw new Error('verification claims must be an array')
  const names = new Set()
  for (const [index, claim] of document.claims.entries()) {
    if (!isPlainObject(claim)) throw new Error(`verification claims[${index}] must be an object`)
    if (names.has(claim.claim)) throw new Error(`verification claim ${claim.claim} appears more than once`)
    names.add(claim.claim)
    const compared = Object.hasOwn(claim, 'expected') && Object.hasOwn(claim, 'actual')
    if (claim.status === 'verified' && compared && claim.expected !== claim.actual) throw new Error(`verified claim ${claim.claim} has different expected and actual values`)
    if (claim.status === 'mismatch' && compared && claim.expected === claim.actual) throw new Error(`mismatch claim ${claim.claim} has equal expected and actual values`)
    if (claim.status === 'not-checked' && (typeof claim.input !== 'string' || !claim.input)) throw new Error(`not-checked claim ${claim.claim} must name the input that would check it`)
  }
  const expected = verificationResult(document.claims)
  if (document.result !== expected) throw new Error(`verification result ${document.result} does not follow from its claims (${expected})`)
  return document
}
