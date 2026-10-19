#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

import { createFeedRefreshReceipt, validateFeedRefreshReceipt } from './feed-refresh-receipt.mjs'
import { createReleaseReceipt, validateReleaseReceipt } from './release-receipt.mjs'
import { validateJsonSchema } from '../lib/json-schema.mjs'
import {
  EVAL_RESULTS_SCHEMA,
  FEED_REFRESH_RECEIPT_SCHEMA,
  RELEASE_RECEIPT_SCHEMA,
  assertSha512Integrity,
  assertValidEvalResults,
  assertValidFeedRefreshReceipt,
  assertValidReleaseReceipt,
  sha512Integrity,
} from '../lib/receipts.mjs'
import { loadDocumentSchemaCatalog, validateDocument } from '../lib/validate-document.mjs'

const root = path.resolve(import.meta.dirname, '..')
const catalog = loadDocumentSchemaCatalog()
const commit = 'a'.repeat(40)
const runUrl = 'https://github.com/thossullivan/model-eol/actions/runs/123456'
const integrity = sha512Integrity(Buffer.from('model-eol receipt fixture'))

const kinds = {
  'feed-refresh-receipt': { schema: FEED_REFRESH_RECEIPT_SCHEMA, validate: assertValidFeedRefreshReceipt },
  'npm-release-result': { schema: RELEASE_RECEIPT_SCHEMA, validate: assertValidReleaseReceipt },
  eval: { schema: EVAL_RESULTS_SCHEMA, validate: assertValidEvalResults },
}

const schemaErrors = (type, document) => validateJsonSchema(document, catalog.byType.get(type), { registry: catalog.registry })

const valid = {
  clean: ['feed-refresh-receipt', createFeedRefreshReceipt({ repoDir: root, state: 'clean', checkedAt: '2026-10-19T05:23:00Z', refreshRunUrl: runUrl, refreshSha: commit })],
  pending: ['feed-refresh-receipt', createFeedRefreshReceipt({ repoDir: root, state: 'pending', checkedAt: '2026-10-19T05:23:00.125Z', refreshRunUrl: runUrl, refreshSha: 'b'.repeat(64), pendingPrUrl: 'https://github.com/thossullivan/model-eol/pull/115' })],
  released: ['npm-release-result', createReleaseReceipt({ sourceCommit: commit, version: '0.8.4', releaseCommit: 'c'.repeat(40), registryIntegrity: integrity })],
  'not released': ['npm-release-result', createReleaseReceipt({ sourceCommit: commit })],
  'configured eval': ['eval', {
    schema: EVAL_RESULTS_SCHEMA,
    generated: '2026-10-19T05:23:00.000Z',
    base_sha: commit,
    plan_digest: 'd'.repeat(64),
    eval_config_digest: 'e'.repeat(64),
    configured: true,
    results: [
      { publisher: 'openai', id: 'gpt-4', via: null, feed_digest: 'f'.repeat(64), status: 'pass', exit_code: 0, report: 'ok' },
      { publisher: 'openai', id: 'gpt-4', via: 'azure-ai-foundry', feed_digest: '1'.repeat(64), status: 'fail', exit_code: 1, report: null },
      { publisher: 'anthropic', id: 'claude-x', via: null, feed_digest: '2'.repeat(64), status: 'timeout', exit_code: null, report: null },
    ],
  }],
  'unconfigured eval': ['eval', {
    schema: EVAL_RESULTS_SCHEMA,
    generated: '2026-10-19T05:23:00.000Z',
    base_sha: commit,
    plan_digest: 'd'.repeat(64),
    eval_config_digest: 'e'.repeat(64),
    configured: false,
    results: [],
  }],
}

for (const [name, [type, document]] of Object.entries(valid)) {
  assert.doesNotThrow(() => kinds[type].validate(document), `${name} receipt passes its code validator`)
  assert.deepEqual(schemaErrors(type, document), [], `${name} receipt passes its public schema`)
  const result = validateDocument(document)
  assert.equal(result.type, type, `${name} receipt is detected by its schema value`)
  assert.deepEqual(result.errors, [], `${name} receipt passes model-eol validate`)
}
assert(valid.clean[1].feeds.length > 0 && valid.clean[1].feeds.every(feed => feed.path.startsWith('feeds/')), 'the clean fixture hashes the repository feeds')

const withFeeds = (receipt, feeds) => ({ ...structuredClone(receipt), feeds })
const clean = () => structuredClone(valid.clean[1])
const pending = () => structuredClone(valid.pending[1])
const released = () => structuredClone(valid.released[1])
const notReleased = () => structuredClone(valid['not released'][1])
const configured = () => structuredClone(valid['configured eval'][1])
const unconfigured = () => structuredClone(valid['unconfigured eval'][1])
const set = (factory, mutate) => () => {
  const document = factory()
  mutate(document)
  return document
}
const nonCanonicalIntegrity = `${integrity.slice(0, -3)}${integrity.at(-3) === 'B' ? 'C' : 'B'}==`
const shortIntegrity = `sha512-${crypto.randomBytes(63).toString('base64')}`
const sha384PrefixIntegrity = `sha384-${integrity.slice('sha512-'.length)}`

const invalid = [
  ['feed-refresh-receipt', 'non-object receipt', () => [], true],
  ['feed-refresh-receipt', 'unknown key', set(clean, receipt => { receipt.extra = true }), true],
  ['feed-refresh-receipt', 'wrong schema string', set(clean, receipt => { receipt.schema = 'model-eol/feed-refresh-receipt@0.2' }), true],
  ['feed-refresh-receipt', 'unknown state', set(clean, receipt => { receipt.state = 'dirty' }), true],
  ['feed-refresh-receipt', 'changed disagrees with state', set(clean, receipt => { receipt.changed = true }), true],
  ['feed-refresh-receipt', 'pending disagrees with state', set(pending, receipt => { receipt.pending = false }), true],
  ['feed-refresh-receipt', 'pending without pending_pr', set(pending, receipt => { delete receipt.pending_pr }), true],
  ['feed-refresh-receipt', 'clean with pending_pr', set(clean, receipt => { receipt.pending_pr = 'https://github.com/thossullivan/model-eol/pull/1' }), true],
  ['feed-refresh-receipt', 'uppercase commit hex', set(clean, receipt => { receipt.refresh_commit = 'A'.repeat(40) }), true],
  ['feed-refresh-receipt', 'short commit', set(clean, receipt => { receipt.refresh_commit = 'a'.repeat(39) }), true],
  ['feed-refresh-receipt', 'http refresh_run', set(clean, receipt => { receipt.refresh_run = 'http://github.com/thossullivan/model-eol/actions/runs/1' }), true],
  ['feed-refresh-receipt', 'refresh_run with userinfo', set(clean, receipt => { receipt.refresh_run = 'https://user@github.com/thossullivan/model-eol/actions/runs/1' }), true],
  ['feed-refresh-receipt', 'http pending_pr', set(pending, receipt => { receipt.pending_pr = 'http://github.com/thossullivan/model-eol/pull/1' }), true],
  ['feed-refresh-receipt', 'checked_at with an offset', set(clean, receipt => { receipt.checked_at = '2026-10-19T05:23:00+00:00' }), true],
  ['feed-refresh-receipt', 'checked_at on an impossible date', set(clean, receipt => { receipt.checked_at = '2026-02-30T05:23:00Z' }), true],
  ['feed-refresh-receipt', 'empty feeds', () => withFeeds(clean(), []), true],
  ['feed-refresh-receipt', 'feed outside feeds/', () => withFeeds(clean(), [{ path: 'schema/model-eol.schema.json', sha256: '0'.repeat(64) }]), true],
  ['feed-refresh-receipt', 'nested feed path', () => withFeeds(clean(), [{ path: 'feeds/sub/openai.json', sha256: '0'.repeat(64) }]), true],
  ['feed-refresh-receipt', 'bad feed digest', set(clean, receipt => { receipt.feeds[0].sha256 = '0'.repeat(63) }), true],
  ['feed-refresh-receipt', 'unknown feed key', set(clean, receipt => { receipt.feeds[0].size = 1 }), true],
  ['feed-refresh-receipt', 'pending with changed false', set(pending, receipt => { receipt.changed = false }), true],
  ['feed-refresh-receipt', 'refresh_run with only a password', set(clean, receipt => { receipt.refresh_run = 'https://:p@github.com/thossullivan/model-eol/actions/runs/1' }), true],
  ['feed-refresh-receipt', 'uppercase feed name', () => withFeeds(clean(), [{ path: 'feeds/OpenAI.json', sha256: '0'.repeat(64) }]), true],
  ['feed-refresh-receipt', 'underscore feed name', () => withFeeds(clean(), [{ path: 'feeds/open_ai.json', sha256: '0'.repeat(64) }]), true],
  ['feed-refresh-receipt', 'exact duplicate feed item', () => withFeeds(clean(), [clean().feeds[0], clean().feeds[0]]), true],
  ['feed-refresh-receipt', 'unsorted feeds', () => withFeeds(clean(), [...clean().feeds].reverse()), false],
  ['feed-refresh-receipt', 'duplicate feed path', () => withFeeds(clean(), [
    { path: 'feeds/openai.json', sha256: '0'.repeat(64) },
    { path: 'feeds/openai.json', sha256: '1'.repeat(64) },
  ]), false],

  ['npm-release-result', 'non-object result', () => null, true],
  ['npm-release-result', 'unknown key', set(released, receipt => { receipt.extra = true }), true],
  ['npm-release-result', 'wrong schema string', set(released, receipt => { receipt.schema = 'model-eol/npm-release-result@0.1' }), true],
  ['npm-release-result', 'released is not boolean', set(notReleased, receipt => { receipt.released = 'false' }), true],
  ['npm-release-result', 'released true without version', set(released, receipt => { delete receipt.version }), true],
  ['npm-release-result', 'released false with version', set(notReleased, receipt => { receipt.version = '0.8.4' }), true],
  ['npm-release-result', 'numeric released with every release field', set(released, receipt => { receipt.released = 1 }), true],
  ['npm-release-result', 'tag outside the release tag pattern', set(released, receipt => { receipt.tag = 'release-0.8.4' }), true],
  ['npm-release-result', 'canonical 63-byte sha512 integrity', set(released, receipt => { receipt.registry_integrity = shortIntegrity }), true],
  ['npm-release-result', 'sha384 prefix on a 64-byte digest', set(released, receipt => { receipt.registry_integrity = sha384PrefixIntegrity }), true],
  ['npm-release-result', 'tag mismatch', set(released, receipt => { receipt.tag = 'v0.8.3' }), false],
  ['npm-release-result', 'non-0.x version', set(released, receipt => { receipt.version = '1.0.0'; receipt.tag = 'v1.0.0' }), true],
  ['npm-release-result', 'leading-zero version', set(released, receipt => { receipt.version = '0.08.4'; receipt.tag = 'v0.08.4' }), true],
  ['npm-release-result', 'bad source commit', set(notReleased, receipt => { receipt.source_commit = 'g'.repeat(40) }), true],
  ['npm-release-result', 'bad release commit', set(released, receipt => { receipt.release_commit = 'a'.repeat(65) }), true],
  ['npm-release-result', 'sha256 integrity', set(released, receipt => { receipt.registry_integrity = `sha256-${crypto.createHash('sha256').update('x').digest('base64')}` }), true],
  ['npm-release-result', 'non-canonical sha512 integrity', set(released, receipt => { receipt.registry_integrity = nonCanonicalIntegrity }), true],
  ['npm-release-result', 'unpadded sha512 integrity', set(released, receipt => { receipt.registry_integrity = integrity.replace(/=+$/, '') }), true],

  ['eval', 'non-object manifest', () => 'eval', true],
  ['eval', 'unknown top-level key', set(configured, manifest => { manifest.extra = true }), true],
  ['eval', 'unknown result key', set(configured, manifest => { manifest.results[0].extra = true }), true],
  ['eval', 'missing result key', set(configured, manifest => { delete manifest.results[1].report }), true],
  ['eval', 'wrong schema string', set(configured, manifest => { manifest.schema = 'model-eol.eval/0.2' }), true],
  ['eval', 'generated with an offset', set(configured, manifest => { manifest.generated = '2026-10-19T05:23:00+02:00' }), true],
  ['eval', 'generated on an impossible date', set(configured, manifest => { manifest.generated = '2026-02-30T00:00:00Z' }), true],
  ['eval', 'empty result id', set(configured, manifest => { manifest.results[0].id = '' }), true],
  ['eval', 'numeric result id', set(configured, manifest => { manifest.results[0].id = 4 }), true],
  ['eval', 'missing result id', set(configured, manifest => { delete manifest.results[0].id }), true],
  ['eval', 'bad base_sha', set(configured, manifest => { manifest.base_sha = 'a'.repeat(39) }), true],
  ['eval', 'bad plan digest', set(configured, manifest => { manifest.plan_digest = 'D'.repeat(64) }), true],
  ['eval', 'bad config digest', set(configured, manifest => { manifest.eval_config_digest = '0'.repeat(40) }), true],
  ['eval', 'configured is not boolean', set(configured, manifest => { manifest.configured = 1 }), true],
  ['eval', 'results is not an array', set(unconfigured, manifest => { manifest.results = {} }), true],
  ['eval', 'unconfigured with results', set(unconfigured, manifest => { manifest.results = configured().results }), true],
  ['eval', 'bad status enum', set(configured, manifest => { manifest.results[1].status = 'skipped' }), true],
  ['eval', 'pass with a non-zero exit code', set(configured, manifest => { manifest.results[0].exit_code = 1 }), true],
  ['eval', 'pass without an exit code', set(configured, manifest => { manifest.results[0].exit_code = null }), true],
  ['eval', 'fractional exit code', set(configured, manifest => { manifest.results[1].exit_code = 1.5 }), true],
  ['eval', 'unsafe exit code', set(configured, manifest => { manifest.results[1].exit_code = 2 ** 53 }), true],
  ['eval', 'empty publisher', set(configured, manifest => { manifest.results[0].publisher = '' }), true],
  ['eval', 'numeric via', set(configured, manifest => { manifest.results[0].via = 7 }), true],
  ['eval', 'bad feed digest', set(configured, manifest => { manifest.results[0].feed_digest = 'f'.repeat(65) }), true],
  ['eval', 'numeric report', set(configured, manifest => { manifest.results[0].report = 0 }), true],
]

for (const [type, name, build, schemaExpresses] of invalid) {
  const document = build()
  assert.throws(() => kinds[type].validate(document), Error, `${type} ${name} is rejected by the code validator`)
  const errors = schemaErrors(type, document)
  if (schemaExpresses) assert(errors.length > 0, `${type} ${name} is rejected by the public schema`)
  else assert.deepEqual(errors, [], `${type} ${name} is a code-only rule the schema leaves to the validator`)
  const result = validateDocument(document, { type })
  assert(result.errors.length > 0, `${type} ${name} is rejected by model-eol validate`)
  if (!schemaExpresses) assert(result.errors.every(error => error.keyword === 'model-eol-receipt'), `${type} ${name} is rejected through the shared receipt validator`)
}

assert.throws(() => assertSha512Integrity(nonCanonicalIntegrity), /canonical 64-byte/, 'the fixture integrity is non-canonical for the code validator too')
assert.equal(Buffer.from(shortIntegrity.slice('sha512-'.length), 'base64').toString('base64'), shortIntegrity.slice('sha512-'.length), 'the 63-byte fixture is canonical base64')
assert.throws(() => assertSha512Integrity(shortIntegrity), /canonical 64-byte/, 'a canonical 63-byte digest fails only the length rule')
assert.throws(() => assertSha512Integrity(sha384PrefixIntegrity), /npm sha512 Subresource Integrity/, 'a 64-byte digest under another algorithm prefix fails the prefix rule')

const impossibleGenerated = set(configured, manifest => { manifest.generated = '2026-02-30T00:00:00Z' })()
assert.throws(() => assertValidEvalResults(impossibleGenerated), /generated must be a valid UTC ISO 8601 instant/, 'the code validator rejects an impossible generated date')
assert(schemaErrors('eval', impossibleGenerated).some(error => error.path === '$.generated' && error.keyword === 'format'), 'the eval schema rejects an impossible generated date through format date-time')
const duplicateItem = withFeeds(clean(), [clean().feeds[0], clean().feeds[0]])
assert(schemaErrors('feed-refresh-receipt', duplicateItem).some(error => error.keyword === 'uniqueItems'), 'the refresh schema rejects an exact duplicate feed item through uniqueItems')
assert(schemaErrors('npm-release-result', set(released, receipt => { receipt.tag = 'release-0.8.4' })()).some(error => error.path === '$.tag' && error.keyword === 'pattern'), 'the release schema pins the tag pattern')

for (const [type, document, label] of [
  ['eval', set(unconfigured, manifest => { delete manifest.configured })(), 'eval without configured'],
  ['eval', set(configured, manifest => { delete manifest.results[0].status })(), 'eval result without status'],
  ['feed-refresh-receipt', set(clean, receipt => { delete receipt.state })(), 'refresh receipt without state'],
  ['npm-release-result', set(notReleased, receipt => { delete receipt.released })(), 'release result without released'],
]) {
  const errors = schemaErrors(type, document)
  assert(errors.some(error => error.keyword === 'required'), `${label} reports the missing discriminator`)
  assert(!errors.some(error => error.message.includes('matched 2')), `${label} does not report an ambiguous oneOf match`)
}

const schemeUrls = [
  ['HTTPS://github.com/thossullivan/model-eol/actions/runs/1', false],
  ['https://@github.com/thossullivan/model-eol/actions/runs/1', false],
  ['https:github.com/thossullivan/model-eol/actions/runs/1', false],
  [' https://github.com/thossullivan/model-eol/actions/runs/1', false],
  ['https://GitHub.com/thossullivan/model-eol/actions/runs/1', true],
  ['https://github.com:443/thossullivan/model-eol/actions/runs/1', true],
]
for (const [url, schemaAccepts] of schemeUrls) {
  const receipt = set(clean, document => { document.refresh_run = url })()
  assert.doesNotThrow(() => assertValidFeedRefreshReceipt(receipt), `the code validator accepts WHATWG-parseable ${JSON.stringify(url)}`)
  assert.equal(schemaErrors('feed-refresh-receipt', receipt).length === 0, schemaAccepts, `the refresh schema ${schemaAccepts ? 'accepts' : 'refuses'} ${JSON.stringify(url)}`)
}

const unnormalized = set(clean, receipt => { receipt.refresh_run = 'https://GitHub.com:443/thossullivan/model-eol/actions/runs/123456' })()
assert.equal(validateFeedRefreshReceipt(unnormalized, { repoDir: root, expectedRunUrl: runUrl }).matches, true, '--expected-run-url compares the normalized receipt URL')
assert.equal(validateFeedRefreshReceipt(clean(), { repoDir: root, expectedRunUrl: 'https://GITHUB.COM/thossullivan/model-eol/actions/runs/123456' }).matches, true, '--expected-run-url normalizes the expected URL')
assert.throws(() => validateFeedRefreshReceipt(clean(), { repoDir: root, expectedRunUrl: `${runUrl}7` }), /does not match/, '--expected-run-url still rejects a different run')

for (const [label, receipt] of [
  ['unsorted feeds', withFeeds(clean(), [...clean().feeds].reverse())],
  ['state dirty', set(clean, document => { document.state = 'dirty' })()],
]) {
  assert.throws(() => validateFeedRefreshReceipt(receipt, { repoDir: root }), Error, `the feed-refresh script validator rejects ${label}`)
}
assert.throws(() => validateReleaseReceipt(set(released, receipt => { receipt.tag = 'v0.8.3' })()), /does not match version/, 'the release script validator rejects a tag mismatch')

const cliTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-receipts-'))
try {
  for (const [label, receipt] of [
    ['unsorted feeds', withFeeds(clean(), [...clean().feeds].reverse())],
    ['state dirty', set(clean, document => { document.state = 'dirty' })()],
  ]) {
    const file = path.join(cliTemp, `${label.replaceAll(' ', '-')}.json`)
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`)
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'feed-refresh-receipt.mjs'), 'verify', '--repo-dir', root, '--receipt', file, '--require-match'], { encoding: 'utf8' })
    assert.equal(result.status, 1, `feed-refresh verify exits 1 for ${label}: ${result.stderr}`)
    assert.match(result.stderr, /feed refresh receipt failed/, `feed-refresh verify names the failure for ${label}`)
  }
} finally {
  fs.rmSync(cliTemp, { recursive: true, force: true })
}
for (const [type, { schema }] of Object.entries(kinds)) {
  assert.equal(catalog.byType.get(type).properties.schema.const, schema, `${type} schema pins the exact receipt schema string`)
  const unknownVersion = validateDocument({ schema: `${schema}.9` })
  assert.equal(unknownVersion.type, null, `an unknown ${type} version is not auto-detected as ${type}`)
}

console.log('receipt schema and validator assertions passed')
