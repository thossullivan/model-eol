#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  createFeedRefreshReceipt,
  validateFeedRefreshReceipt,
} from './feed-refresh-receipt.mjs'
import { verifyPublicSite } from './verify-public-site.mjs'

const root = path.resolve(import.meta.dirname, '..')
const builder = path.join(root, 'scripts', 'build-public-site.mjs')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-public-site-'))
const repo = path.join(temp, 'repo')
const output = path.join(temp, 'site')
const receiptFile = path.join(temp, 'feed-refresh-receipt.json')
const checkedAt = '2026-08-18T12:34:56Z'
const refreshRun = 'https://github.com/thossullivan/model-eol/actions/runs/123456'
const refreshWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'feed-refresh.yml'), 'utf8')
let server = null

assert(
  refreshWorkflow.includes('startswith("feed-refresh/")') &&
  refreshWorkflow.includes('gh pr edit') &&
  refreshWorkflow.includes('--force-with-lease=') &&
  refreshWorkflow.includes('reviewDecision') &&
  !refreshWorkflow.includes('git push --force origin'),
  'feed refresh workflow safely reuses an open refresh PR',
)

const runGit = args => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

fs.cpSync(root, repo, {
  recursive: true,
  filter: source => {
    const relative = path.relative(root, source)
    const first = relative.split(path.sep)[0]
    return first !== '.git' && first !== 'node_modules'
  },
})
runGit(['init', '--quiet'])
runGit(['add', '--all'])
runGit(['-c', 'user.name=model-eol test', '-c', 'user.email=model-eol@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'public contract fixture'])
const sourceSha = runGit(['rev-parse', 'HEAD'])

const runBuilder = args => spawnSync(process.execPath, [builder, ...args, '--repo-dir', repo], {
  cwd: repo,
  encoding: 'utf8',
})

try {
  const receipt = createFeedRefreshReceipt({
    repoDir: repo,
    state: 'clean',
    checkedAt,
    refreshRunUrl: refreshRun,
    refreshSha: sourceSha,
  })
  assert.equal(receipt.changed, false)
  assert.equal(receipt.pending, false)
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  const receiptCheck = validateFeedRefreshReceipt(receipt, {
    repoDir: repo,
    expectedRunUrl: refreshRun,
    expectedRefreshSha: sourceSha,
  })
  assert.equal(receiptCheck.matches, true)
  assert.deepEqual(receipt.feeds.map(feed => feed.path), ['feeds/amazon.json', 'feeds/anthropic.json', 'feeds/google.json', 'feeds/openai.json'])

  const pending = createFeedRefreshReceipt({
    repoDir: repo,
    state: 'pending',
    checkedAt,
    refreshRunUrl: refreshRun,
    refreshSha: sourceSha,
    pendingPrUrl: 'https://github.com/thossullivan/model-eol/pull/123',
  })
  assert.equal(pending.changed, true)
  assert.equal(pending.pending, true)
  assert.equal(validateFeedRefreshReceipt(pending, { repoDir: repo }).matches, true)

  const result = runBuilder([
    '--out-dir', output,
    '--receipt', receiptFile,
    '--source-sha', sourceSha,
  ])
  assert.equal(result.status, 0, result.stderr)

  const schemaNames = fs.readdirSync(path.join(repo, 'schema')).filter(name => name.endsWith('.json')).sort()
  const feedNames = fs.readdirSync(path.join(repo, 'feeds')).filter(name => name.endsWith('.json')).sort()
  assert(schemaNames.includes('model-eol.check.schema.json'))
  assert.deepEqual(fs.readdirSync(path.join(output, 'schema', '0.1')).sort(), schemaNames)
  assert.deepEqual(fs.readdirSync(path.join(output, 'feeds')).sort(), feedNames)

  const health = JSON.parse(fs.readFileSync(path.join(output, 'health.json'), 'utf8'))
  assert.equal(health.schema, 'model-eol/health@0.1')
  assert.equal(health.last_checked, checkedAt)
  assert.equal(health.refresh_run, refreshRun)
  assert.equal(health.refresh_commit, sourceSha)
  assert.equal(health.published_commit, sourceSha)
  assert.deepEqual(health.feeds.map(feed => feed.publisher).sort(), ['amazon', 'anthropic', 'google', 'openai'])
  for (const feed of health.feeds) {
    const name = `${feed.publisher}.json`
    const bytes = fs.readFileSync(path.join(output, 'feeds', name))
    assert.equal(feed.sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
    assert.equal(feed.url, `https://thossullivan.github.io/model-eol/feeds/${name}`)
    assert.equal(feed.sha256, receipt.feeds.find(item => item.path === `feeds/${name}`).sha256)
  }

  const publication = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'))
  assert.equal(publication.schema, 'model-eol/publication@0.1')
  assert.equal(publication.published_commit, sourceSha)
  assert.equal(publication.schemas.length, schemaNames.length)
  assert(publication.schemas.every(item => item.id === item.url && item.url.startsWith('https://thossullivan.github.io/model-eol/schema/0.1/')))
  assert.equal(publication.atom, 'https://thossullivan.github.io/model-eol/changelog.atom')
  assert.equal(publication.health, 'https://thossullivan.github.io/model-eol/health.json')

  const atom = fs.readFileSync(path.join(output, 'changelog.atom'), 'utf8')
  assert.match(atom, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/)
  assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), /model-eol public data/)

  const dirtyOutput = runBuilder(['--out-dir', output, '--receipt', receiptFile])
  assert.equal(dirtyOutput.status, 1)
  assert.match(dirtyOutput.stderr, /output directory must be empty/)

  const mismatched = structuredClone(receipt)
  mismatched.feeds[0].sha256 = '0'.repeat(64)
  assert.equal(validateFeedRefreshReceipt(mismatched, { repoDir: repo }).matches, false)
  const mismatchedFile = path.join(temp, 'mismatched-receipt.json')
  fs.writeFileSync(mismatchedFile, `${JSON.stringify(mismatched, null, 2)}\n`)
  const mismatchedBuild = runBuilder([
    '--out-dir', path.join(temp, 'mismatched-site'),
    '--receipt', mismatchedFile,
  ])
  assert.equal(mismatchedBuild.status, 1)
  assert.match(mismatchedBuild.stderr, /receipt does not match the feeds being published/)

  const wrongSourceBuild = runBuilder([
    '--out-dir', path.join(temp, 'wrong-source-site'),
    '--receipt', receiptFile,
    '--source-sha', 'f'.repeat(40),
  ])
  assert.equal(wrongSourceBuild.status, 1)
  assert.match(wrongSourceBuild.stderr, /does not match repository HEAD/)

  const schemaInput = path.join(repo, 'schema', 'model-eol.schema.json')
  const schemaBytes = fs.readFileSync(schemaInput)
  fs.writeFileSync(schemaInput, Buffer.concat([schemaBytes, Buffer.from('\n')]))
  const dirtySchemaBuild = runBuilder([
    '--out-dir', path.join(temp, 'dirty-schema-site'),
    '--receipt', receiptFile,
    '--source-sha', sourceSha,
  ])
  fs.writeFileSync(schemaInput, schemaBytes)
  assert.equal(dirtySchemaBuild.status, 1)
  assert.match(dirtySchemaBuild.stderr, /published schema\/feed inputs are dirty relative to/)

  const feedInput = path.join(repo, 'feeds', 'amazon.json')
  const feedBytes = fs.readFileSync(feedInput)
  fs.writeFileSync(feedInput, Buffer.concat([feedBytes, Buffer.from('\n')]))
  const dirtyFeedReceipt = createFeedRefreshReceipt({
    repoDir: repo,
    state: 'clean',
    checkedAt,
    refreshRunUrl: refreshRun,
    refreshSha: sourceSha,
  })
  const dirtyFeedReceiptFile = path.join(temp, 'dirty-feed-receipt.json')
  fs.writeFileSync(dirtyFeedReceiptFile, `${JSON.stringify(dirtyFeedReceipt, null, 2)}\n`)
  const dirtyFeedBuild = runBuilder([
    '--out-dir', path.join(temp, 'dirty-feed-site'),
    '--receipt', dirtyFeedReceiptFile,
    '--source-sha', sourceSha,
  ])
  fs.writeFileSync(feedInput, feedBytes)
  assert.equal(dirtyFeedBuild.status, 1)
  assert.match(dirtyFeedBuild.stderr, /published schema\/feed inputs are dirty relative to/)

  const untrackedFeed = path.join(repo, 'feeds', 'untracked.json')
  fs.copyFileSync(feedInput, untrackedFeed)
  const untrackedReceipt = createFeedRefreshReceipt({
    repoDir: repo,
    state: 'clean',
    checkedAt,
    refreshRunUrl: refreshRun,
    refreshSha: sourceSha,
  })
  const untrackedReceiptFile = path.join(temp, 'untracked-feed-receipt.json')
  fs.writeFileSync(untrackedReceiptFile, `${JSON.stringify(untrackedReceipt, null, 2)}\n`)
  const untrackedFeedBuild = runBuilder([
    '--out-dir', path.join(temp, 'untracked-feed-site'),
    '--receipt', untrackedReceiptFile,
    '--source-sha', sourceSha,
  ])
  fs.unlinkSync(untrackedFeed)
  assert.equal(untrackedFeedBuild.status, 1)
  assert.match(untrackedFeedBuild.stderr, /published schema\/feed inputs are dirty relative to/)

  assert.throws(() => createFeedRefreshReceipt({
    repoDir: repo,
    state: 'clean',
    checkedAt: 'yesterday',
    refreshRunUrl: refreshRun,
    refreshSha: sourceSha,
  }), /valid UTC ISO 8601 instant/)
  assert.throws(() => createFeedRefreshReceipt({
    repoDir: repo,
    state: 'clean',
    checkedAt: '2026-02-30T12:00:00Z',
    refreshRunUrl: refreshRun,
    refreshSha: sourceSha,
  }), /valid UTC ISO 8601 instant/)
  assert.throws(() => createFeedRefreshReceipt({
    repoDir: repo,
    state: 'clean',
    checkedAt,
    refreshRunUrl: 'http://example.test/run',
    refreshSha: sourceSha,
  }), /valid HTTPS URL/)

  let tamperHealth = false
  let redirectHealth = false
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
    const file = path.resolve(output, relative)
    if (!file.startsWith(`${path.resolve(output)}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end('not found')
      return
    }
    if (redirectHealth && relative === 'health.json') {
      response.writeHead(302, { location: '/index.json' }).end()
      return
    }
    if (tamperHealth && relative === 'health.json') {
      response.writeHead(200).end(`${JSON.stringify({ ...health, last_checked: '2026-08-18T12:34:57Z' }, null, 2)}\n`)
      return
    }
    response.writeHead(200).end(fs.readFileSync(file))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const canonicalBase = 'https://thossullivan.github.io/model-eol/'
  const fetchLocalContract = async (url, options) => {
    const requested = new URL(url)
    const relative = requested.pathname.slice('/model-eol/'.length)
    const response = await fetch(`http://127.0.0.1:${address.port}/${relative}`, options)
    return {
      ok: response.ok,
      status: response.status,
      redirected: response.redirected,
      url: requested.href,
      arrayBuffer: () => response.arrayBuffer(),
    }
  }
  const live = await verifyPublicSite({
    baseUrl: canonicalBase,
    expectedDir: output,
    fetchImpl: fetchLocalContract,
    attempts: 1,
    retryMs: 0,
  })
  assert.deepEqual({ feeds: live.feeds, schemas: live.schemas }, { feeds: feedNames.length, schemas: schemaNames.length })
  assert.equal(live.lastChecked, checkedAt)
  assert.equal(live.refreshCommit, sourceSha)
  assert.equal(live.publishedCommit, sourceSha)

  await assert.rejects(() => verifyPublicSite({
    baseUrl: canonicalBase,
    expectedDir: output,
    fetchImpl: async (url, options) => ({
      ...await fetchLocalContract(url, options),
      url: 'https://example.test/redirected.json',
    }),
    attempts: 1,
    retryMs: 0,
  }), /health\.json did not match the exact built artifact/)

  tamperHealth = true
  await assert.rejects(() => verifyPublicSite({
    baseUrl: canonicalBase,
    expectedDir: output,
    fetchImpl: fetchLocalContract,
    attempts: 1,
    retryMs: 0,
  }), /health\.json did not match the exact built artifact/)
  tamperHealth = false
  redirectHealth = true
  await assert.rejects(() => verifyPublicSite({
    baseUrl: canonicalBase,
    expectedDir: output,
    fetchImpl: fetchLocalContract,
    attempts: 1,
    retryMs: 0,
  }), /health\.json did not match the exact built artifact/)
  redirectHealth = false

  const omittedFeedSite = path.join(temp, 'omitted-feed-site')
  fs.cpSync(output, omittedFeedSite, { recursive: true })
  const omittedHealth = JSON.parse(fs.readFileSync(path.join(omittedFeedSite, 'health.json'), 'utf8'))
  const omittedIndex = JSON.parse(fs.readFileSync(path.join(omittedFeedSite, 'index.json'), 'utf8'))
  omittedHealth.feeds.pop()
  omittedIndex.feeds.pop()
  fs.writeFileSync(path.join(omittedFeedSite, 'health.json'), `${JSON.stringify(omittedHealth, null, 2)}\n`)
  fs.writeFileSync(path.join(omittedFeedSite, 'index.json'), `${JSON.stringify(omittedIndex, null, 2)}\n`)
  await assert.rejects(() => verifyPublicSite({
    baseUrl: canonicalBase,
    expectedDir: omittedFeedSite,
    fetchImpl: fetchLocalContract,
    attempts: 1,
    retryMs: 0,
  }), /health does not enumerate every built feed exactly once/)

  const wrongHealthSite = path.join(temp, 'wrong-health-site')
  fs.cpSync(output, wrongHealthSite, { recursive: true })
  const wrongHealthIndex = JSON.parse(fs.readFileSync(path.join(wrongHealthSite, 'index.json'), 'utf8'))
  wrongHealthIndex.health = 'https://thossullivan.github.io/model-eol/index.json'
  fs.writeFileSync(path.join(wrongHealthSite, 'index.json'), `${JSON.stringify(wrongHealthIndex, null, 2)}\n`)
  await assert.rejects(() => verifyPublicSite({
    baseUrl: canonicalBase,
    expectedDir: wrongHealthSite,
    fetchImpl: fetchLocalContract,
    attempts: 1,
    retryMs: 0,
  }), /publication health URL does not identify health\.json/)

  await assert.rejects(() => verifyPublicSite({
    baseUrl: 'https://example.test/model-eol/',
    expectedDir: output,
    fetchImpl: fetchLocalContract,
    attempts: 1,
    retryMs: 0,
  }), /baseUrl must be the canonical public contract root/)
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  fs.rmSync(temp, { recursive: true, force: true })
}

console.log('public site and receipt contract tests passed')
