#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'
import {
  FEED_REFRESH_RECEIPT_SCHEMA,
  assertHttpsUrl,
  assertInstant,
  assertSha,
  assertValidFeedRefreshReceipt,
  hashFeedDirectory,
} from '../lib/receipts.mjs'

export { FEED_REFRESH_RECEIPT_SCHEMA, hashFeedDirectory }

const usage = `Usage:
  node scripts/feed-refresh-receipt.mjs create --repo-dir DIR --out FILE --state clean|pending --checked-at ISO_DATE --refresh-run-url HTTPS_URL --refresh-sha SHA [--pending-pr-url HTTPS_URL]
  node scripts/feed-refresh-receipt.mjs verify --repo-dir DIR --receipt FILE [--expected-run-url HTTPS_URL] [--expected-refresh-sha SHA] [--github-output FILE] [--require-match]`

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
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
  assertValidFeedRefreshReceipt(receipt)
  const runUrl = assertHttpsUrl(receipt.refresh_run, 'refresh_run')
  const refreshSha = receipt.refresh_commit
  if (expectedRunUrl !== null && runUrl !== assertHttpsUrl(expectedRunUrl, 'expected refresh run URL')) {
    throw new Error(`receipt refresh_run ${runUrl} does not match ${expectedRunUrl}`)
  }
  if (expectedRefreshSha !== null && refreshSha !== assertSha(expectedRefreshSha, 'expected refresh SHA')) {
    throw new Error(`receipt refresh_commit ${refreshSha} does not match ${expectedRefreshSha}`)
  }

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
