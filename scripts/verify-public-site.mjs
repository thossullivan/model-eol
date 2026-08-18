#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'

const CONTRACT_BASE = new URL('https://thossullivan.github.io/model-eol/')
const digestPattern = /^[0-9a-f]{64}$/
const shaPattern = /^[0-9a-f]{40,64}$/

const usage = 'Usage: node scripts/verify-public-site.mjs --base-url HTTPS_URL --expected-dir DIR [--attempts COUNT] [--retry-ms MILLISECONDS]'

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const readExpected = (root, relativePath) => {
  const fullPath = path.join(root, ...relativePath.split('/'))
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(`expected build artifact is missing ${relativePath}`)
  return fs.readFileSync(fullPath)
}

const parseExpectedJson = (root, relativePath) => {
  try {
    return JSON.parse(readExpected(root, relativePath).toString('utf8'))
  } catch (error) {
    throw new Error(`expected ${relativePath} is not valid JSON: ${error.message}`)
  }
}

const contractPath = (value, label) => {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (parsed.origin !== CONTRACT_BASE.origin || !parsed.pathname.startsWith(CONTRACT_BASE.pathname) || parsed.search || parsed.hash) {
    throw new Error(`${label} must be beneath ${CONTRACT_BASE.href}`)
  }
  const relative = decodeURIComponent(parsed.pathname.slice(CONTRACT_BASE.pathname.length))
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${label} has an unsafe public path`)
  return relative
}

const assertExpectedContract = ({ expectedDir, health, publication }) => {
  if (health.schema !== 'model-eol/health@0.1') throw new Error(`expected health schema is ${health.schema}`)
  if (!shaPattern.test(health.refresh_commit ?? '')) throw new Error('expected health has an invalid refresh_commit')
  if (!shaPattern.test(health.published_commit ?? '')) throw new Error('expected health has an invalid published_commit')
  if (!/^\d{4}-\d{2}-\d{2}T/.test(health.last_checked ?? '')) throw new Error('expected health has an invalid last_checked')
  if (publication.schema !== 'model-eol/publication@0.1') throw new Error(`expected publication schema is ${publication.schema}`)
  if (publication.published_commit !== health.published_commit) throw new Error('expected index and health published commits differ')
  if (JSON.stringify(publication.feeds) !== JSON.stringify(health.feeds)) throw new Error('expected index and health feed records differ')
  if (contractPath(publication.health, 'health') !== 'health.json') throw new Error('publication health URL does not identify health.json')
  if (!Array.isArray(health.feeds) || !health.feeds.length) throw new Error('expected health has no feeds')
  if (!Array.isArray(publication.schemas) || !publication.schemas.length) throw new Error('expected publication has no schema URLs')

  const assets = [
    { relativePath: 'health.json', kind: 'health' },
    { relativePath: 'index.json', kind: 'index' },
    { relativePath: 'index.html', kind: 'index-page' },
  ]
  const localFeeds = fs.readdirSync(path.join(expectedDir, 'feeds')).filter(name => name.endsWith('.json')).sort()
  const indexedFeeds = []
  for (const [index, feed] of health.feeds.entries()) {
    if (!digestPattern.test(feed.sha256 ?? '')) throw new Error(`expected feed ${index} has an invalid SHA-256 digest`)
    const relativePath = contractPath(feed.url, `feeds[${index}].url`)
    if (!relativePath.startsWith('feeds/')) throw new Error(`feeds[${index}].url is not a feed URL`)
    const expectedBytes = readExpected(expectedDir, relativePath)
    if (sha256(expectedBytes) !== feed.sha256) throw new Error(`${relativePath} does not match its expected health digest`)
    indexedFeeds.push(path.basename(relativePath))
    assets.push({ relativePath, kind: 'feed' })
  }
  if (JSON.stringify(indexedFeeds.sort()) !== JSON.stringify(localFeeds)) throw new Error('health does not enumerate every built feed exactly once')
  const atomPath = contractPath(publication.atom, 'atom')
  if (atomPath !== 'changelog.atom') throw new Error('publication atom URL does not identify changelog.atom')
  assets.push({ relativePath: atomPath, kind: 'atom' })

  const localSchemas = fs.readdirSync(path.join(expectedDir, 'schema', '0.1')).filter(name => name.endsWith('.json')).sort()
  if (publication.schemas.length !== localSchemas.length) throw new Error(`expected publication must contain all ${localSchemas.length} built schema URLs`)
  const indexedSchemas = []
  for (const [index, schema] of publication.schemas.entries()) {
    if (schema.id !== schema.url) throw new Error(`schemas[${index}] id and URL differ`)
    const relativePath = contractPath(schema.url, `schemas[${index}].url`)
    if (!relativePath.startsWith('schema/0.1/')) throw new Error(`schemas[${index}].url is not a versioned schema URL`)
    indexedSchemas.push(path.basename(relativePath))
    readExpected(expectedDir, relativePath)
    assets.push({ relativePath, kind: 'schema' })
  }
  if (JSON.stringify(indexedSchemas.sort()) !== JSON.stringify(localSchemas)) throw new Error('publication index does not enumerate every built schema exactly once')
  const paths = assets.map(asset => asset.relativePath)
  if (new Set(paths).size !== paths.length) throw new Error('publication contract contains duplicate asset URLs')
  return assets
}

const fetchExact = async ({ fetchImpl, url, expectedBytes, attempts, retryMs, label }) => {
  let detail = 'no response'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', headers: { accept: '*/*' } })
      if (!response.ok) detail = `HTTP ${response.status}`
      else if (response.redirected) detail = 'unexpected redirect'
      else if (response.url && new URL(response.url).href !== new URL(url).href) detail = `unexpected final URL ${response.url}`
      else {
        const actual = Buffer.from(await response.arrayBuffer())
        if (actual.equals(expectedBytes)) return
        detail = `SHA-256 ${sha256(actual)} (expected ${sha256(expectedBytes)})`
      }
    } catch (error) {
      detail = error.message
    }
    if (attempt < attempts) await delay(retryMs)
  }
  throw new Error(`${label} did not match the exact built artifact after ${attempts} attempt(s): ${detail}`)
}

export async function verifyPublicSite({
  baseUrl,
  expectedDir,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryMs = 5000,
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) throw new Error('attempts must be an integer from 1 to 20')
  if (!Number.isSafeInteger(retryMs) || retryMs < 0 || retryMs > 60000) throw new Error('retryMs must be an integer from 0 to 60000')
  const expectedRoot = path.resolve(expectedDir)
  const health = parseExpectedJson(expectedRoot, 'health.json')
  const publication = parseExpectedJson(expectedRoot, 'index.json')
  const assets = assertExpectedContract({ expectedDir: expectedRoot, health, publication })
  const suppliedBase = new URL(baseUrl)
  const normalizedBase = `${suppliedBase.origin}${suppliedBase.pathname.replace(/\/?$/, '/')}`
  if (suppliedBase.username || suppliedBase.password || suppliedBase.search || suppliedBase.hash || normalizedBase !== CONTRACT_BASE.href) {
    throw new Error(`baseUrl must be the canonical public contract root ${CONTRACT_BASE.href}`)
  }
  const deployedBase = CONTRACT_BASE

  for (const asset of assets) {
    const expectedBytes = readExpected(expectedRoot, asset.relativePath)
    await fetchExact({
      fetchImpl,
      url: new URL(asset.relativePath, deployedBase),
      expectedBytes,
      attempts,
      retryMs,
      label: asset.relativePath,
    })
  }
  return {
    lastChecked: health.last_checked,
    refreshCommit: health.refresh_commit,
    publishedCommit: health.published_commit,
    feeds: assets.filter(asset => asset.kind === 'feed').length,
    schemas: assets.filter(asset => asset.kind === 'schema').length,
  }
}

async function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    options: {
      'base-url': { type: 'string' },
      'expected-dir': { type: 'string' },
      attempts: { type: 'string' },
      'retry-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: usage,
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  if (positionals.length) fail(`unexpected positional argument: ${positionals[0]}`)
  if (!values['base-url']) fail('--base-url is required')
  if (!values['expected-dir']) fail('--expected-dir is required')
  let base
  try {
    base = new URL(values['base-url'])
  } catch {
    fail('--base-url must be a valid HTTPS URL')
  }
  if (base.protocol !== 'https:') fail('--base-url must be a valid HTTPS URL')
  const attempts = values.attempts === undefined ? 6 : Number(values.attempts)
  const retryMs = values['retry-ms'] === undefined ? 5000 : Number(values['retry-ms'])
  const result = await verifyPublicSite({
    baseUrl: base.href,
    expectedDir: values['expected-dir'],
    attempts,
    retryMs,
  })
  console.log(`verified exact deployed contract from ${result.publishedCommit}: ${result.feeds} feeds, ${result.schemas} schemas, checked ${result.lastChecked}`)
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`public site verification failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
