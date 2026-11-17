#!/usr/bin/env node
// Offline tests for the Vertex AI parser reading the Markdown copy of the model versions page.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import strictAssert from 'node:assert/strict'
import {
  DISTRIBUTORS,
  VERTEX_MODEL_VERSIONS_MARKDOWN_URL,
  VERTEX_MODEL_VERSIONS_URL,
  findDistributorFixture,
  loadDistributorSource,
  mergeDistributions,
  parseVertexModelVersionsHtml,
  parseVertexModelVersionsMarkdown,
} from '../distributors.mjs'
import { shapeSources } from '../shapes.mjs'

const fixtures = path.join(import.meta.dirname, 'fixture')
const markdownFixture = fs.readFileSync(path.join(fixtures, 'vertex-model-versions.md'), 'utf8')
const excerpt = fs.readFileSync(path.join(fixtures, 'pipe-tables', 'vertex-ai-model-versions.md'), 'utf8')
let failures = 0

const test = async (name, check) => {
  try {
    await check()
    console.log(`ok: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}: ${error.message}`)
    failures++
  }
}

const table = (...rows) => [
  '| Model ID | Release date | Retirement date | Replacement model ID |',
  '|---|---|---|---|',
  ...rows.map(([id, date]) => `| ${id.includes('`') || id.includes(' ') ? id : `\`${id}\``} | May 1, 2025 | ${date} |   |`),
  '',
].join('\n')
const qualifier = "## Latest available models\n\nWhile retirement timelines may be extended, they won't be moved to an earlier date than what is listed.\n\n"
const precisions = markdown => Object.fromEntries(parseVertexModelVersionsMarkdown(markdown).map(record => [record.vertexId, record.date_precision ?? 'exact']))
const byId = records => new Map(records.map(record => [record.vertexId, record]))

await test('the Markdown fixture parses to the same records as the recorded HTML page', () => {
  const html = fs.readFileSync(path.join(fixtures, 'vertex-model-versions.html'), 'utf8')
  strictAssert.deepEqual(parseVertexModelVersionsMarkdown(markdownFixture), parseVertexModelVersionsHtml(html))
})

await test('a real Markdown excerpt keeps the precision, blank-date, and archive rules', () => {
  const records = byId(parseVertexModelVersionsMarkdown(excerpt))
  strictAssert.deepEqual(records.get('gemini-4-argon'), { vertexId: 'gemini-4-argon', shutdown: '2027-10-13', date_precision: 'earliest' })
  strictAssert.deepEqual(records.get('gemini-embedding-001'), { vertexId: 'gemini-embedding-001', shutdown: '2028-05-20', date_precision: 'earliest' })
  strictAssert.deepEqual(records.get('gemini-embedding-2'), { vertexId: 'gemini-embedding-2' })
  strictAssert.deepEqual(records.get('gemini-4-hydrogen'), { vertexId: 'gemini-4-hydrogen' })
  strictAssert.deepEqual(records.get('veo-3.0-generate-001'), { vertexId: 'veo-3.0-generate-001', shutdown: '2026-06-30' })
  strictAssert.ok([...records.keys()].every(id => !id.includes('/') && !id.includes('`')), 'link-wrapped IDs keep only the code text')
})

await test('a footnote asterisk that Google escapes inside a code span is not part of the model ID', () => {
  const records = parseVertexModelVersionsMarkdown(table(['`textembedding-gecko@003\\*`', 'May 24, 2025'], ['[`gemini-a\\*`](https://example.test/a.md.txt)', 'May 24, 2025']))
  strictAssert.deepEqual(records.map(record => record.vertexId), ['textembedding-gecko@003', 'gemini-a'])
})

await test('model IDs with whitespace are skipped', () => {
  const records = parseVertexModelVersionsMarkdown(table(['Gemini 2.5 Pro', 'October 20, 2026'], ['`gemini 2.5`', 'October 20, 2026'], ['gemini-b', 'October 20, 2026']))
  strictAssert.deepEqual(records.map(record => record.vertexId), ['gemini-b'])
})

await test('tables with unknown headers are skipped, and a page without a recognised table fails closed', () => {
  const unknown = '| Model | Shutdown |\n|---|---|\n| `gemini-a` | October 20, 2026 |\n'
  strictAssert.deepEqual(parseVertexModelVersionsMarkdown(`${unknown}\n${table(['gemini-b', 'October 20, 2026'])}`).map(record => record.vertexId), ['gemini-b'])
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(unknown), /no recognised model table/)
  strictAssert.throws(() => parseVertexModelVersionsMarkdown('## Latest available models\n\nNo tables.\n'), /no recognised model table/)
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(''), /lifecycle page is empty/)
})

await test('a misaligned row or an unrecognised date fails closed', () => {
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(`${table(['gemini-a', 'October 20, 2026'])}`.replace('|   |\n', '\n')), /table row has 3 cells; the header has 4/)
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(table(['gemini-a', 'Soon'])), /gemini-a has an unrecognised retirement date: Soon/)
})

await test('an HTML body, a raw HTML table, or a setext heading fails closed', () => {
  strictAssert.throws(() => parseVertexModelVersionsMarkdown('<!doctype html><html><body><table></table></body></html>'), /source is HTML, not Markdown/)
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(`${table(['gemini-a', 'October 20, 2026'])}\n<table><tr><th>Model ID</th><th>Retirement date</th></tr></table>\n`), /raw HTML table/)
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(`Retired models\n--------------\n\n${table(['gemini-a', 'October 20, 2026'])}`), /line 2: setext heading/)
  strictAssert.deepEqual(precisions(`Intro.\n\n---\n\n${table(['gemini-a', 'October 20, 2026'])}`), { 'gemini-a': 'exact' })
})

await test('the available-models statement applies to its sections but not to the retired archive', () => {
  const markdown = `# Model versions and lifecycle\n\n${qualifier}### Models available for at least 12 months after release\n\nThe following table lists the models that will be available for at least 12 months after initial release:\n\n### Gemini models\n\n${table(['gemini-a', 'May 19, 2027 or later'], ['gemini-b', 'October 20, 2026'])}\n### Embeddings models\n\n${table(['text-embedding-a', 'April 1, 2027'])}\n### Retired models\n\n#### The following table lists the retired models (click to expand)\n\n${table(['gemini-old', 'April 21, 2025'], ['gemini-old-floor', 'June 30, 2026 or later'])}\n## Migrate to a latest available model\n\nUpdate your application to point to the recommended upgrades.\n`
  strictAssert.deepEqual(precisions(markdown), { 'gemini-a': 'earliest', 'gemini-b': 'earliest', 'text-embedding-a': 'earliest', 'gemini-old': 'exact', 'gemini-old-floor': 'earliest' })
})

await test('a section that posts fixed dates is exact beneath the available-models qualifier', () => {
  const shorter = 'Short-term availability models remain active until a replacement model is\nreleased and a retirement date is announced. When we schedule a model for\nretirement, we post a fixed date in the following table that gives you at least\n45 days to migrate.\n\nThe following table lists models available for shorter terms:\n\n'
  const page = section => `${qualifier}### Models available for at least 12 months after release\n\n### Gemini models\n\n${table(['gemini-long', 'May 19, 2027 or later'], ['gemini-long-plain', 'May 19, 2027'])}\n### Models available for shorter availability periods\n\n${section}${table(['gemini-short', 'January 28, 2027'], ['gemini-short-floor', 'January 28, 2027 or later'], ['gemini-short-open', 'No retirement date announced'])}\n### Retired models\n\n${table(['gemini-old', 'April 21, 2025'])}`
  strictAssert.deepEqual(precisions(page(shorter)), { 'gemini-long': 'earliest', 'gemini-long-plain': 'earliest', 'gemini-short': 'exact', 'gemini-short-floor': 'earliest', 'gemini-short-open': 'exact', 'gemini-old': 'exact' })
  strictAssert.ok(!Object.hasOwn(byId(parseVertexModelVersionsMarkdown(page(shorter))).get('gemini-short-open'), 'shutdown'))
  for (const negated of ["we don't post a fixed date", 'we do not post a fixed date', 'there is no fixed date', 'we never post fixed dates']) {
    strictAssert.equal(precisions(page(`When we schedule a model for retirement, ${negated} in the following table.\n\n`))['gemini-short'], 'earliest', negated)
  }
  strictAssert.equal(precisions(page('The following table lists models available for shorter terms:\n\n'))['gemini-short'], 'earliest')
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(page(`${shorter}Retirement timelines may be extended.\n\n`)), /section "Models available for shorter availability periods" states both fixed and earliest-possible retirement dates/)
  const nested = `${qualifier}### Models available for shorter availability periods\n\n${shorter}#### Gemini models\n\n${table(['gemini-nested', 'January 28, 2027'])}`
  strictAssert.deepEqual(precisions(nested), { 'gemini-nested': 'exact' })
  const introFixed = `We post a fixed date for every model.\n\n## Models\n\n${table(['gemini-intro', 'January 28, 2027'])}`
  strictAssert.deepEqual(precisions(introFixed), { 'gemini-intro': 'exact' })
  const introQualified = `Retirement timelines may be extended.\n\n## Models\n\n${table(['gemini-intro', 'January 28, 2027'])}`
  strictAssert.deepEqual(precisions(introQualified), { 'gemini-intro': 'earliest' })
  const introFixedUnderQualifier = `We post a fixed date for every model.\n\n${qualifier}${table(['gemini-intro', 'January 28, 2027'])}`
  strictAssert.deepEqual(precisions(introFixedUnderQualifier), { 'gemini-intro': 'earliest' })
})

await test('a precision phrase in another section, a comment, or a code block does not apply', () => {
  const sibling = `## Latest available models\n\n### Gemini models\n\n${table(['gemini-a', 'May 19, 2027 or later'])}\n### Embeddings models\n\n${table(['gemini-b', 'October 20, 2026'])}\n## What's next\n\nQuotas may be raised for projects created on or later than 2026.\n`
  strictAssert.deepEqual(precisions(sibling), { 'gemini-a': 'earliest', 'gemini-b': 'exact' })
  const hidden = `## Models\n\n<!-- Dates may move to May 2027 or later. -->\n\n\`\`\`\nRetirement timelines may be extended.\n\`\`\`\n\n${table(['gemini-c', 'October 20, 2026'])}`
  strictAssert.deepEqual(precisions(hidden), { 'gemini-c': 'exact' })
})

await test('a retirement-worded heading beneath the qualifier fails closed instead of guessing', () => {
  for (const heading of ['Models retired after 2027', 'Models scheduled to be retired', 'Not yet retired']) {
    strictAssert.throws(() => parseVertexModelVersionsMarkdown(`${qualifier}### ${heading}\n\n${table(['gemini-a', 'October 20, 2026'])}`), /mentions retirement beneath the date qualifier of "Latest available models"/, heading)
  }
  strictAssert.deepEqual(precisions(`## Models scheduled to be retired\n\n${table(['gemini-a', 'October 20, 2026'])}`), { 'gemini-a': 'exact' })
})

await test('an archive row yields to the available row with the same date, and different dates conflict', () => {
  const available = `### Embeddings models\n\n${table(['text-embedding-a', 'April 1, 2027'])}\n`
  const archive = `### Retired models\n\n${table(['text-embedding-a', 'April 1, 2027'])}\n`
  strictAssert.deepEqual(precisions(qualifier + available + archive), { 'text-embedding-a': 'earliest' })
  strictAssert.deepEqual(precisions(qualifier + archive + available), { 'text-embedding-a': 'earliest' })
  const moved = `${qualifier}${available}### Retired models\n\n${table(['text-embedding-a', 'April 21, 2025'])}`
  strictAssert.throws(() => parseVertexModelVersionsMarkdown(moved), /conflicting rows for text-embedding-a: 2027-04-01 \(earliest\) and 2025-04-21 \(exact\)/)
})

await test('Markdown records bind to the publisher their namespace names', () => {
  const records = parseVertexModelVersionsMarkdown(table(['claude-sonnet-4-20250514', 'October 14, 2026'], ['gemini-a', 'October 20, 2026']))
  const merged = mergeDistributions([{ publisher: 'google', models: [{ id: 'gemini-a' }] }, { publisher: 'anthropic', models: [{ id: 'claude-sonnet-4-20250514' }] }], { records, via: 'vertex-ai' })
  strictAssert.equal(merged.feeds[0].models[0].distributions[0].shutdown, '2026-10-20')
  strictAssert.equal(merged.feeds[1].models[0].distributions[0].shutdown, '2026-10-14')
  const prefixed = parseVertexModelVersionsMarkdown(table(['publishers/google/models/shared-vertex-model', 'February 1, 2027']))
  strictAssert.throws(() => mergeDistributions([{ publisher: 'anthropic', models: [{ id: 'shared-vertex-model' }] }], { records: prefixed, via: 'vertex-ai' }), /binds to google.*anthropic feed/)
})

await test('the refresh fetches the Markdown copy but the feed cites the human page', async () => {
  const config = DISTRIBUTORS['vertex-ai']
  strictAssert.equal(config.sourceUrl, VERTEX_MODEL_VERSIONS_URL)
  strictAssert.equal(config.sourceFetchUrl, VERTEX_MODEL_VERSIONS_MARKDOWN_URL)
  strictAssert.equal(VERTEX_MODEL_VERSIONS_MARKDOWN_URL, `${VERTEX_MODEL_VERSIONS_URL}.md.txt`)
  const urls = []
  const source = await loadDistributorSource('vertex-ai', { fetchImpl: async url => { urls.push(String(url)); return new Response(markdownFixture) }, notice: () => {} })
  strictAssert.deepEqual(urls, [VERTEX_MODEL_VERSIONS_MARKDOWN_URL])
  strictAssert.equal(source.sourceUrl, VERTEX_MODEL_VERSIONS_URL)
  const merged = mergeDistributions([{ publisher: 'google', models: [{ id: 'gemini-2.5-pro' }] }], { records: source.records, sourceUrl: source.sourceUrl, via: 'vertex-ai' })
  strictAssert.equal(merged.feeds[0].models[0].distributions[0].source, VERTEX_MODEL_VERSIONS_URL)
  strictAssert.equal(shapeSources().find(entry => entry.name === 'vertex-ai').url, VERTEX_MODEL_VERSIONS_MARKDOWN_URL)
  for (const [name, entry] of Object.entries(DISTRIBUTORS).filter(([, entry]) => !entry.sourceFetchUrl)) {
    strictAssert.equal(shapeSources().find(item => item.name === name).url, entry.sourceUrl, name)
  }
})

await test('fixture lookup finds the Markdown fixture and its .md fallbacks, never an HTML page', async () => {
  strictAssert.equal(path.basename(findDistributorFixture(fixtures, 'vertex-ai')), 'vertex-model-versions.md')
  const source = await loadDistributorSource('vertex-ai', { fixtures, notice: () => {} })
  strictAssert.deepEqual(source.records, parseVertexModelVersionsMarkdown(markdownFixture))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-vertex-fixture-'))
  try {
    fs.writeFileSync(path.join(dir, 'vertex-ai.html'), '<table></table>')
    strictAssert.throws(() => findDistributorFixture(dir, 'vertex-ai'), /missing vertex-ai fixture/)
    fs.writeFileSync(path.join(dir, 'vertex-ai.md'), markdownFixture)
    strictAssert.equal(path.basename(findDistributorFixture(dir, 'vertex-ai')), 'vertex-ai.md')
    strictAssert.equal(path.basename(findDistributorFixture(path.join(fixtures), 'aws-bedrock')), 'bedrock-lifecycle.md')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

if (failures) {
  console.error(`${failures} Vertex Markdown test(s) failed`)
  process.exit(1)
}
