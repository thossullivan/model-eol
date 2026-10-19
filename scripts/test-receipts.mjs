#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'

import { createFeedRefreshReceipt } from './feed-refresh-receipt.mjs'
import { createReleaseReceipt } from './release-receipt.mjs'
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
for (const [type, { schema }] of Object.entries(kinds)) {
  assert.equal(catalog.byType.get(type).properties.schema.const, schema, `${type} schema pins the exact receipt schema string`)
  const unknownVersion = validateDocument({ schema: `${schema}.9` })
  assert.equal(unknownVersion.type, null, `an unknown ${type} version is not auto-detected as ${type}`)
}

console.log('receipt schema and validator assertions passed')
