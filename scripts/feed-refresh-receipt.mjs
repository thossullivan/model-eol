#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'

export const FEED_REFRESH_RECEIPT_SCHEMA = 'model-eol/feed-refresh-receipt@0.1'

const shaPattern = /^[0-9a-f]{40,64}$/
const digestPattern = /^[0-9a-f]{64}$/
const feedNamePattern = /^[a-z0-9][a-z0-9-]*\.json$/

const usage = `Usage:
  node scripts/feed-refresh-receipt.mjs create --repo-dir DIR --out FILE --state clean|pending --checked-at ISO_DATE --refresh-run-url HTTPS_URL --refresh-sha SHA [--pending-pr-url HTTPS_URL]
  node scripts/feed-refresh-receipt.mjs verify --repo-dir DIR --receipt FILE [--expected-run-url HTTPS_URL] [--expected-refresh-sha SHA] [--github-output FILE] [--require-match]`

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const assertExactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly ${wanted.join(', ')}; got ${actual.join(', ')}`)
  }
}

const assertInstant = (value, label) => {
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

const assertSha = (value, label) => {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`${label} must be a 40-64 character lowercase hexadecimal Git commit`)
  return value
}

const assertHttpsUrl = (value, label) => {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`${label} must be a valid HTTPS URL`)
  return parsed.toString()
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

export const hashFeedDirectory = repoDir => {
  const feedDir = path.join(path.resolve(repoDir), 'feeds')
  const names = fs.readdirSync(feedDir).filter(name => name.endsWith('.json')).sort()
  if (!names.length) throw new Error(`no JSON feeds found in ${feedDir}`)
  return names.map(name => ({
    path: `feeds/${name}`,
    sha256: sha256(fs.readFileSync(path.join(feedDir, name))),
  }))
}

export function createFeedRefreshReceipt({
  repoDir,
  state,
  checkedAt,
  refreshRunUrl,
  refreshSha,
  pendingPrUrl = null,
}) {
  if (state !== 'clean' && state !== 'pending') throw new Error('receipt state must be clean or pending')
  const receipt = {
    schema: FEED_REFRESH_RECEIPT_SCHEMA,
    state,
    changed: state === 'pending',
    pending: state === 'pending',
    checked_at: assertInstant(checkedAt, 'checked_at'),
    refresh_run: assertHttpsUrl(refreshRunUrl, 'refresh_run'),
    refresh_commit: assertSha(refreshSha, 'refresh_commit'),
    feeds: hashFeedDirectory(repoDir),
  }
  if (state === 'pending') receipt.pending_pr = assertHttpsUrl(pendingPrUrl, 'pending_pr')
  else if (pendingPrUrl !== null) throw new Error('a clean receipt cannot include pending_pr')
  return receipt
}

export function validateFeedRefreshReceipt(receipt, {
  repoDir,
  expectedRunUrl = null,
  expectedRefreshSha = null,
} = {}) {
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
  const runUrl = assertHttpsUrl(receipt.refresh_run, 'refresh_run')
  const refreshSha = assertSha(receipt.refresh_commit, 'refresh_commit')
  if (receipt.state === 'pending') assertHttpsUrl(receipt.pending_pr, 'pending_pr')
  if (expectedRunUrl !== null && runUrl !== assertHttpsUrl(expectedRunUrl, 'expected refresh run URL')) {
    throw new Error(`receipt refresh_run ${runUrl} does not match ${expectedRunUrl}`)
  }
  if (expectedRefreshSha !== null && refreshSha !== assertSha(expectedRefreshSha, 'expected refresh SHA')) {
    throw new Error(`receipt refresh_commit ${refreshSha} does not match ${expectedRefreshSha}`)
  }
  if (!Array.isArray(receipt.feeds) || !receipt.feeds.length) throw new Error('receipt feeds must be a non-empty array')
  const priorPaths = new Set()
  for (const [index, feed] of receipt.feeds.entries()) {
    if (!isPlainObject(feed)) throw new Error(`receipt feeds[${index}] must be an object`)
    assertExactKeys(feed, ['path', 'sha256'], `receipt feeds[${index}]`)
    if (typeof feed.path !== 'string' || !feed.path.startsWith('feeds/') || !feedNamePattern.test(feed.path.slice('feeds/'.length))) {
      throw new Error(`receipt feeds[${index}].path must identify one feeds/*.json file`)
    }
    if (priorPaths.has(feed.path)) throw new Error(`receipt contains duplicate feed path ${feed.path}`)
    priorPaths.add(feed.path)
    if (typeof feed.sha256 !== 'string' || !digestPattern.test(feed.sha256)) throw new Error(`receipt ${feed.path} has an invalid SHA-256 digest`)
  }
  const sorted = [...receipt.feeds].sort((left, right) => left.path.localeCompare(right.path))
  if (JSON.stringify(sorted) !== JSON.stringify(receipt.feeds)) throw new Error('receipt feeds must be sorted by path')

  const actualFeeds = hashFeedDirectory(repoDir)
  const actualByPath = new Map(actualFeeds.map(feed => [feed.path, feed.sha256]))
  const receiptByPath = new Map(receipt.feeds.map(feed => [feed.path, feed.sha256]))
  const mismatches = []
  for (const feed of actualFeeds) {
    const expected = receiptByPath.get(feed.path)
    if (expected === undefined) mismatches.push(`${feed.path}: missing from receipt`)
    else if (expected !== feed.sha256) mismatches.push(`${feed.path}: expected ${expected}, got ${feed.sha256}`)
  }
  for (const feed of receipt.feeds) {
    if (!actualByPath.has(feed.path)) mismatches.push(`${feed.path}: not present in repository`)
  }
  return { receipt, matches: mismatches.length === 0, mismatches }
}

export const readFeedRefreshReceipt = (receiptFile, options) => {
  let receipt
  try {
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read feed refresh receipt ${receiptFile}: ${error.message}`)
  }
  return validateFeedRefreshReceipt(receipt, options)
}

const appendGithubOutput = (file, result) => {
  fs.appendFileSync(file, [
    `matches=${result.matches}`,
    `state=${result.receipt.state}`,
    `checked_at=${result.receipt.checked_at}`,
    `refresh_run=${result.receipt.refresh_run}`,
    `refresh_sha=${result.receipt.refresh_commit}`,
    '',
  ].join('\n'))
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'repo-dir': { type: 'string' },
      out: { type: 'string' },
      state: { type: 'string' },
      'checked-at': { type: 'string' },
      'refresh-run-url': { type: 'string' },
      'refresh-sha': { type: 'string' },
      'pending-pr-url': { type: 'string' },
      receipt: { type: 'string' },
      'expected-run-url': { type: 'string' },
      'expected-refresh-sha': { type: 'string' },
      'github-output': { type: 'string' },
      'require-match': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    help: usage,
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  const [command, ...extra] = positionals
  if (!command || extra.length || !['create', 'verify'].includes(command)) fail('command must be create or verify')
  const repoDir = values['repo-dir'] ?? process.cwd()
  if (command === 'create') {
    for (const name of ['out', 'state', 'checked-at', 'refresh-run-url', 'refresh-sha']) {
      if (!values[name]) fail(`--${name} is required for create`)
    }
    const receipt = createFeedRefreshReceipt({
      repoDir,
      state: values.state,
      checkedAt: values['checked-at'],
      refreshRunUrl: values['refresh-run-url'],
      refreshSha: values['refresh-sha'],
      pendingPrUrl: values['pending-pr-url'] ?? null,
    })
    fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
    fs.writeFileSync(values.out, `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(`wrote ${receipt.state} feed refresh receipt for ${receipt.feeds.length} feeds to ${values.out}`)
    return 0
  }

  if (!values.receipt) fail('--receipt is required for verify')
  const result = readFeedRefreshReceipt(values.receipt, {
    repoDir,
    expectedRunUrl: values['expected-run-url'] ?? null,
    expectedRefreshSha: values['expected-refresh-sha'] ?? null,
  })
  if (values['github-output']) appendGithubOutput(values['github-output'], result)
  if (!result.matches) {
    console.error(`receipt feed hashes do not match repository feeds:\n${result.mismatches.map(item => `- ${item}`).join('\n')}`)
    if (values['require-match']) return 3
  } else {
    console.log(`${result.receipt.state} receipt matches all ${result.receipt.feeds.length} repository feeds`)
  }
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`feed refresh receipt failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
