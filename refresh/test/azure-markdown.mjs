#!/usr/bin/env node
// Offline tests for the Azure AI Foundry parser reading the Markdown copy of the retirement schedule.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import strictAssert from 'node:assert/strict'
import {
  AZURE_MODEL_RETIREMENT_SCHEDULE_URL,
  DISTRIBUTORS,
  findDistributorFixture,
  loadDistributorSource,
  mergeDistributions,
  parseAzureModelRetirementScheduleHtml,
  parseAzureModelRetirementScheduleMarkdown,
} from '../distributors.mjs'
import { shapeSources } from '../shapes.mjs'

const fixtures = path.join(import.meta.dirname, 'fixture')
const markdownFixture = fs.readFileSync(path.join(fixtures, 'azure-model-retirement-schedule.md'), 'utf8')
const pairedHtml = fs.readFileSync(path.join(fixtures, 'azure-model-retirement-schedule-paired.html'), 'utf8')
const excerpt = fs.readFileSync(path.join(fixtures, 'pipe-tables', 'azure-ai-foundry-retirement-schedule.md'), 'utf8')
const now = '2026-11-16T00:00:00Z'
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

const header = '| Model | Version | Lifecycle | Retirement date | Replacement |\n| --- | --- | --- | --- | --- |'
const row = (model, version = '1', lifecycle = 'GA', retirement = '2027-01-01') => `| ${model} | ${version} | ${lifecycle} | ${retirement} | - |`
const table = (section, rows) => `### ${section}\n\n${header}\n${rows.join('\n')}\n\n`
const cited = (marker = '^3^') => row('footnoted', '2025-04-14', 'Deprecated', `2027-04-14${marker}`)
const offer = (number, text = 'April 14, 2027 applies to all active offers for footnoted version 2025-04-14. Regional Standard deployments retired on March 31, 2026; that date is unchanged.') => `^${number}^ ${text}\n\n`
const footnoted = (rows = [cited()]) => table('Azure OpenAI', rows)
const parse = (markdown, clock = now) => parseAzureModelRetirementScheduleMarkdown(markdown, { now: clock })
const failure = (markdown, clock = now) => {
  try {
    parse(markdown, clock)
  } catch (error) {
    return error.message
  }
  throw new Error('expected the parser to fail closed')
}

await test('the Markdown fixture parses to the same records and conflicts as the HTML page recorded with it', () => {
  const html = parseAzureModelRetirementScheduleHtml(pairedHtml, { now })
  const markdown = parse(markdownFixture)
  strictAssert.ok(markdown.records.length > 100 && markdown.conflicts.length > 0)
  strictAssert.deepEqual(markdown, html)
})

await test('the footnoted gpt-4o rows of the fixture keep their cell dates', () => {
  const records = new Map(parse(markdownFixture).records.filter(record => record.publisher).map(record => [record.azureId, record]))
  strictAssert.equal(records.get('gpt-4o-2024-05-13').shutdown, '2027-01-14')
  strictAssert.equal(records.get('gpt-4o-2024-08-06').shutdown, '2027-04-14')
  strictAssert.ok([...records.values()].every(record => !Object.hasOwn(record, 'date_precision')))
})

await test('a real excerpt whose footnote text was cut off fails closed instead of trusting the marker', () => {
  strictAssert.match(failure(excerpt), /gpt-4\.1-mini version 2025-04-14 retirement cites footnote 3, which the table does not define/)
})

await test('a ^N^ marker becomes a footnote the cell date must be stated in', () => {
  const record = parse(footnoted([cited(), row('plain-row')]) + offer(3) + 'Provisioned deployments are not upgraded automatically.\n').records[0]
  strictAssert.deepEqual([record.azureId, record.shutdown, Object.hasOwn(record, 'date_precision')], ['footnoted-2025-04-14', '2027-04-14', false])
  strictAssert.match(failure(footnoted() + offer(3, 'Applies to Global Standard.') + 'April 14, 2027 is the date.\n'), /footnote 3 does not state the retirement date 2027-04-14/)
  strictAssert.equal(parse(footnoted() + '^3^ Applies to every active offer\non April 14, 2027.\n').records[0].shutdown, '2027-04-14')
})

await test('footnote dates must not be later, nor earlier and still in the future', () => {
  strictAssert.match(failure(footnoted() + offer(3, 'April 14, 2027 applies to Global Standard; provisioned offers retire on May 1, 2027.')), /footnote 3 states a later date 2027-05-01/)
  strictAssert.match(failure(footnoted() + offer(3, 'April 14, 2027 applies to Global Standard; Regional Standard retires on December 1, 2026.')), /earlier date 2026-12-01 that is not past on 2026-11-16/)
  strictAssert.match(failure(footnoted() + offer(3), '2026-03-31T12:00:00Z'), /earlier date 2026-03-31 that is not past on 2026-03-31/)
  strictAssert.match(failure(footnoted() + offer(3), 'not a date'), /parser has no valid refresh day/)
  strictAssert.match(failure(footnoted() + 'Batch offers retire in Q3 2027.\n\n' + offer(3)), /notes before the first footnote has a date in an unrecognised format/)
  const two = footnoted([row('first-cited', '2024-05-13', 'Deprecated', '2027-01-14^2^'), row('second-cited', '2024-08-06', 'Deprecated', '2027-04-14^3^')])
  const notes = offer(2, 'January 14, 2027 applies to all offers.') + offer(3, 'April 14, 2027 applies to all offers.')
  strictAssert.deepEqual(parse(two + notes).records.map(record => record.shutdown), ['2027-01-14', '2027-04-14'])
  strictAssert.match(failure(two + notes + 'Global Batch for every version above retires on May 1, 2027.\n'), /first-cited version 2024-05-13 retirement cites footnote 2, and the notes after the last footnote states a later date 2027-05-01/)
})

await test('wording that loosens a date anywhere after the table fails closed, through invisible characters and entities', () => {
  strictAssert.match(failure(footnoted() + offer(3, 'No earlier than April 14, 2027.')), /approximate \("No earlier than"\)/)
  strictAssert.match(failure(footnoted() + offer(3) + 'Dates are subject to change.\n'), /footnote 3 makes the date approximate \("subject to change"\)/)
  strictAssert.match(failure(footnoted([row('first-cited', '2024-05-13', 'Deprecated', '2027-01-14^2^'), cited()]) + offer(2, 'January 14, 2027 applies.') + offer(3) + 'Dates are subject to change.\n'), /first-cited version 2024-05-13 retirement cites footnote 2, and the notes after the table make dates approximate \("subject to change"\)/)
  strictAssert.match(failure(footnoted() + offer(3, 'No ear​lier than April 14, 2027.')), /approximate/)
  strictAssert.match(failure(footnoted() + offer(3, 'April 14, 2027 applies. &lt;!-- No earlier than then --&gt;')), /approximate/)
  strictAssert.match(failure(footnoted() + offer(3, 'April 14, 2027 applies; Batch retires on *May 1*, 2027.')), /footnote 3 states a later date 2027-05-01/)
})

await test('a missing, repeated, commented-out, or misplaced footnote fails closed', () => {
  strictAssert.match(failure(footnoted([cited('^4^')]) + offer(3)), /cites footnote 4, which the table does not define/)
  strictAssert.match(failure(footnoted() + offer(3) + offer(3)), /footnote 3, which the table defines more than once/)
  strictAssert.match(failure(footnoted() + '<!-- ^3^ April 14, 2027 applies to all offers. -->\n'), /footnote 3, which the table does not define/)
  strictAssert.match(failure(footnoted() + '### Cohere\n\n' + offer(3)), /footnote 3, which the table does not define/)
  strictAssert.match(failure(footnoted() + table('Azure OpenAI', [row('second-table')]) + offer(3)), /footnote 3, which the table does not define/)
  strictAssert.match(failure(footnoted() + '- ^3^ April 14, 2027 applies to all offers.\n'), /footnote 3, which the table does not define/)
  strictAssert.equal(parse(footnoted() + offer(3) + table('Cohere', [row('other-section')]) + offer(3, 'April 1, 2027 applies to other offers.')).records[0].shutdown, '2027-04-14')
})

await test('wording that loosens dates before or after a table fails every dated row, footnoted or not', () => {
  const plain = table('Azure OpenAI', [row('plain-dated', '2025-04-14', 'Deprecated', '2027-04-14')])
  strictAssert.equal(parse(plain + 'Provisioned deployments are not upgraded automatically.\n').records[0].shutdown, '2027-04-14')
  for (const note of ['Retirement dates are no earlier than listed.\n', '- Dates are tentative and may change.\n', '> [!NOTE]\n> Retirement dates are estimates.\n']) {
    strictAssert.match(failure(plain + note), /plain-dated version 2025-04-14 retirement is dated, and the notes after the table make dates approximate/, note)
  }
  const sectionNote = '### Azure OpenAI\n\nRetirement dates listed are the earliest possible dates.\n\n'
  strictAssert.match(failure(sectionNote + plain.replace('### Azure OpenAI\n\n', '')), /plain-dated version 2025-04-14 retirement is dated, and the section before the table makes dates approximate \("earliest"\)/)
  const groupNote = '## Foundry Models sold by Azure\n\nRetirement dates are planned and may change.\n\n'
  strictAssert.match(failure(groupNote + plain), /plain-dated version 2025-04-14 retirement is dated, and the section before the table makes dates approximate \("planned"\)/)
  strictAssert.match(failure(footnoted() + offer(3) + table('Cohere', [row('other-section')]) + offer(3, 'No earlier than 2027-04-14.')), /Cohere\/other-section version 1 retirement is dated, and the notes after the table make dates approximate \("No earlier than"\)/)
  strictAssert.match(failure(groupNote.replace('## Foundry Models sold by Azure', '### Azure OpenAI') + footnoted().replace('### Azure OpenAI\n\n', '') + offer(3)), /footnoted version 2025-04-14 retirement cites footnote 3, and the section before the table makes dates approximate \("planned"\)/)
  const undated = table('Azure OpenAI', [row('undated', '1', 'GA', '-')])
  strictAssert.deepEqual(parse(groupNote + undated + 'Dates are tentative.\n').records.map(record => [record.azureId, record.shutdown]), [['undated', undefined]])
  const otherSection = table('Cohere', [row('cohere-dated')]) + 'Cohere dates are tentative.\n\n' + plain
  strictAssert.match(failure(otherSection), /Cohere\/cohere-dated version 1 retirement is dated, and the notes after the table/)
  strictAssert.equal(parse(table('Cohere', [row('cohere-undated', '1', 'GA', '-')]) + 'Cohere dates are tentative.\n\n' + plain).records.at(-1).shutdown, '2027-04-14')
  strictAssert.equal(parse('# Retirement schedule\n\nThe Replacement column is the target for automatic upgrades.\n\n## Foundry Models sold by Azure\n\n' + plain).records[0].shutdown, '2027-04-14')
})

await test('markers outside the retirement column, escaped markers, and markers in code stop the run', () => {
  strictAssert.match(failure(footnoted([row('marked-version', '2025-04-14^3^')]) + offer(3)), /unsupported version/)
  strictAssert.match(failure(footnoted([row('marked-lifecycle', '1', 'GA^3^')]) + offer(3)), /unsupported lifecycle status/)
  strictAssert.match(failure(footnoted([row('marked-model^3^')]) + offer(3)), /invalid model id/)
  for (const marker of ['\\^3\\^', '`^3^`', '^3^ or later', '^3a^', '^3^^4^', ' 3']) {
    strictAssert.match(failure(footnoted([cited(marker)]) + offer(3) + offer(4)), /footnoted version 2025-04-14 retirement has an invalid date/, marker)
  }
  strictAssert.match(failure(footnoted([row('code-date', '1', 'GA', '`2027-04-14^3^`')]) + offer(3)), /code-date version 1 retirement has an invalid date: 2027-04-14\^3\^/)
})

await test('sections bind to publishers by heading, and rows before any section fail closed', () => {
  const records = parse(['Azure OpenAI', 'Anthropic', 'Mistral AI', 'Cohere', 'Meta'].map(section => table(section, [row(`${section.toLowerCase().replace(/\s+/g, '-')}-model`)])).join('')).records
  strictAssert.deepEqual(records.map(record => [record.section, record.publisher]), [['Azure OpenAI', 'openai'], ['Anthropic', 'anthropic'], ['Mistral AI', 'mistral'], ['Cohere', 'cohere'], ['Meta', undefined]])
  strictAssert.match(failure(`${header}\n${row('unowned-model')}\n`), /unowned-model version 1 is missing a publisher section/)
  const merged = mergeDistributions([{ publisher: 'openai', models: [{ id: 'claude-collision' }] }], { via: 'azure-ai-foundry', records: parse(table('Meta', [row('claude-collision')])).records })
  strictAssert.ok(!merged.feeds[0].models[0].distributions && merged.noPublisherFeed.length === 1)
})

await test('hosting rows collapse, conflicting dates keep the earliest, and Mistral or Cohere conflicts stop the run', () => {
  const parsed = parse(table('Anthropic', [row('claude-x', '2', 'GA', '2027-06-30'), row('claude-x', '1', 'Deprecated', '2027-02-10')]))
  strictAssert.deepEqual(parsed.records.map(record => [record.azureId, record.shutdown, record.status]), [['claude-x', '2027-02-10', 'legacy']])
  strictAssert.equal(parsed.conflicts.length, 1)
  strictAssert.match(failure(table('Mistral AI', [row('mistral-x', '1'), row('mistral-x', '2', 'GA', '2028-01-01')])), /conflicting rows/)
})

await test('header drift fails closed, fine-tuning tables are skipped, and a page without a lifecycle table fails', () => {
  const drifted = '### Azure OpenAI\n\n| Model | Version | Status | Retirement date | Replacement |\n| --- | --- | --- | --- | --- |\n| model-a | 1 | GA | 2027-01-01 | - |\n'
  strictAssert.match(failure(drifted), /invalid header row: model \| version \| status \| retirement date \| replacement/)
  const fineTuning = '#### Fine-tuned models\n\n| Model | Version | Training retirement date | Deployment retirement date |\n| --- | --- | --- | --- |\n| gpt-4.1 | 2025-04-14 | No earlier than 2027-04-14^1^ | 2027-10-14 |\n\n^1^ For existing customers only.\n'
  strictAssert.deepEqual(parse(table('Azure OpenAI', [row('lifecycle-model')]) + fineTuning).records.map(record => record.azureId), ['lifecycle-model'])
  strictAssert.match(failure(`### Azure OpenAI\n\n${fineTuning}`), /no recognised lifecycle table/)
  strictAssert.match(failure(''), /lifecycle page is empty/)
})

await test('a misaligned row, an HTML body, a raw HTML table, a setext heading, or a reserved character fails closed', () => {
  strictAssert.throws(() => parse(table('Azure OpenAI', ['| model-a | 1 | GA | 2027-01-01 |'])), /table row has 4 cells; the header has 5/)
  strictAssert.throws(() => parse('<!DOCTYPE html>\n<html><body><h3>Azure OpenAI</h3></body></html>'), /azure-ai-foundry lifecycle source is HTML, not Markdown/)
  strictAssert.throws(() => parse(`${table('Azure OpenAI', [row('model-a')])}<table><tr><th>Model</th></tr></table>\n`), /raw HTML table/)
  strictAssert.throws(() => parse(`Azure OpenAI\n------------\n\n${header}\n${row('model-a')}\n`), /line 2: setext heading/)
  strictAssert.throws(() => parse(`${table('Azure OpenAI', [row('model-a')])}\uE0003\uE001 text\n`), /U\+E000 or U\+E001/)
  strictAssert.equal(parse(`Intro.\n\n---\n\n${table('Azure OpenAI', [row('model-a')])}`).records.length, 1)
})

await test('the refresh asks for Markdown, follows redirects only to https, and cites the human page', async () => {
  const config = DISTRIBUTORS['azure-ai-foundry']
  strictAssert.deepEqual(config.sourceHeaders, { Accept: 'text/markdown' })
  strictAssert.equal(config.sourceUrl, AZURE_MODEL_RETIREMENT_SCHEDULE_URL)
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(markdownFixture)
  }
  const source = await loadDistributorSource('azure-ai-foundry', { fetchImpl, now, env: {}, notice: () => {} })
  strictAssert.equal(requests.length, 1)
  strictAssert.equal(requests[0].url, AZURE_MODEL_RETIREMENT_SCHEDULE_URL)
  strictAssert.equal(requests[0].init.headers.Accept, 'text/markdown')
  strictAssert.equal(requests[0].init.redirect, 'follow')
  const downgraded = async () => Object.defineProperty(new Response(markdownFixture), 'url', { value: 'http://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule' })
  const refused = await loadDistributorSource('azure-ai-foundry', { fetchImpl: downgraded, now, env: {}, notice: () => {} }).then(() => '', error => error.message)
  strictAssert.match(refused, /azure-ai-foundry fetch failed for .*: redirected to a http: URL/)
  const moved = async () => Object.defineProperty(new Response(markdownFixture), 'url', { value: 'https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule-moved' })
  strictAssert.deepEqual((await loadDistributorSource('azure-ai-foundry', { fetchImpl: moved, now, env: {}, notice: () => {} })).records, parse(markdownFixture).records)
  strictAssert.deepEqual(source.records, parse(markdownFixture).records)
  const merged = mergeDistributions([{ publisher: 'openai', models: [{ id: 'whisper' }] }], { records: source.records, sourceUrl: source.sourceUrl, via: 'azure-ai-foundry' })
  strictAssert.equal(merged.feeds[0].models[0].distributions[0].source, AZURE_MODEL_RETIREMENT_SCHEDULE_URL)
  const shape = shapeSources().find(entry => entry.name === 'azure-ai-foundry')
  strictAssert.deepEqual([shape.url, shape.headers], [AZURE_MODEL_RETIREMENT_SCHEDULE_URL, { Accept: 'text/markdown' }])
  const html = await loadDistributorSource('azure-ai-foundry', { fetchImpl: async () => new Response(pairedHtml), now, env: {}, notice: () => {} }).then(() => '', error => error.message)
  strictAssert.match(html, /raw HTML table|source is HTML, not Markdown/)
  const page = await loadDistributorSource('azure-ai-foundry', { fetchImpl: async () => new Response('<!DOCTYPE html><html><body></body></html>'), now, env: {}, notice: () => {} }).then(() => '', error => error.message)
  strictAssert.match(page, /source is HTML, not Markdown/)
})

await test('fixture lookup finds the Markdown fixture and its .md fallbacks, never an HTML page', async () => {
  strictAssert.equal(path.basename(findDistributorFixture(fixtures, 'azure-ai-foundry')), 'azure-model-retirement-schedule.md')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-azure-fixture-'))
  try {
    fs.writeFileSync(path.join(dir, 'azure-ai-foundry.html'), pairedHtml)
    strictAssert.throws(() => findDistributorFixture(dir, 'azure-ai-foundry'), /missing azure-ai-foundry fixture/)
    fs.writeFileSync(path.join(dir, 'azure-ai-foundry.md'), markdownFixture)
    strictAssert.equal(path.basename(findDistributorFixture(dir, 'azure-ai-foundry')), 'azure-ai-foundry.md')
    const notices = []
    const source = await loadDistributorSource('azure-ai-foundry', { fixtures: dir, now, env: { AZURE_MANAGEMENT_TOKEN: 'set', AZURE_SUBSCRIPTION_ID: 'set' }, notice: line => notices.push(line), fetchImpl: () => { throw new Error('no network in a fixture run') } })
    strictAssert.deepEqual(source.records, parse(markdownFixture).records)
    strictAssert.ok(notices.includes('notice: azure models API not read in a fixture run'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

if (failures) {
  console.error(`${failures} Azure Markdown test(s) failed`)
  process.exit(1)
}
