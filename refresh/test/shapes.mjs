#!/usr/bin/env node
// Offline tests for the source structure check. Every CLI run reads synthetic fixtures from a temporary directory.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import strictAssert from 'node:assert/strict'
import {
  SNAPSHOT_FILE,
  compareShapes,
  htmlTableShapes,
  markdocTableShapes,
  normalizeHeaderText,
  readSnapshot,
  renderShapeDiff,
  shapeSources,
  snapshotDocument,
} from '../shapes.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const shapesCli = path.join(root, 'refresh', 'shapes.mjs')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-shapes-test-'))
let failures = 0

const test = (name, check) => {
  try {
    check()
    console.log(`ok: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}: ${error.message}`)
    failures++
  }
}

const run = args => {
  const result = spawnSync(process.execPath, [shapesCli, ...args], { encoding: 'utf8', cwd: root })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const htmlTable = (headers, rows = [['a', 'b']]) => `<table><thead><tr>${headers.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`
const markdocTable = (headers, rows) => ['{% table %}', ...headers.map(label => `  * ${label}`), ...rows.flatMap(row => ['', '  ---', '', ...row.map(cell => `  * ${cell}`)]), '{% /table %}'].join('\n')

test('header text normalization folds case, whitespace, entities, and invisible characters', () => {
  strictAssert.equal(normalizeHeaderText('  Shutdown\u00a0\u200bDate\n'), 'shutdown date')
  strictAssert.equal(normalizeHeaderText('Retire\u00adment\u2014date'), 'retirement-date')
  strictAssert.deepEqual(htmlTableShapes(htmlTable(['Shutdown&nbsp;<b>Date</b>', 'Affected&#x200B; Model<br>', '<code>Notice</code> date'])), ['shutdown date | affected model | notice date [3 cols]'])
})

test('HTML header rows come from thead, then from leading all-th rows, and headerless tables record only their width', () => {
  const vertexStyle = '<table><tr><th>Model ID</th><th>Retirement date</th></tr><tr><td>x</td><td>y</td></tr></table>'
  const headerless = '<table><tr><td>Z.ai GLM</td><td>5.2</td><td colspan="2">9/29/2026</td></tr></table>'
  const rowHeaders = '<table><tr><th>Key</th><td>value</td></tr></table>'
  strictAssert.deepEqual(htmlTableShapes(vertexStyle + headerless + rowHeaders), ['(no header row) [2 cols]', '(no header row) [4 cols]', 'model id | retirement date [2 cols]'])
})

test('HTML extraction ignores comments and scripts, reads nested tables separately, and rejects an unbalanced table', () => {
  const page = `<!-- ${htmlTable(['Hidden'])} --><script>const t = '${htmlTable(['Scripted'])}'</script><table><tr><th>Outer</th></tr><tr><td>${htmlTable(['Inner'])}</td></tr></table>`
  strictAssert.deepEqual(htmlTableShapes(page), ['inner [2 cols]', 'outer [1 cols]'])
  strictAssert.throws(() => htmlTableShapes(`${htmlTable(['Model'])}<table><tr><th>Open</th></tr>`), /unbalanced <table> tag/)
})

test('two dated sections sharing one HTML header shape give one fingerprint entry', () => {
  const page = ['2026-09-01', '2026-11-01'].map(date => `<h3>${date}: Retirement</h3>${htmlTable(['Shutdown Date', 'Deprecated Model'], [[date, `model-${date}`]])}`).join('')
  strictAssert.deepEqual(htmlTableShapes(page), ['shutdown date | deprecated model [2 cols]'])
})

test('the table width counts colspan over every row, so a wider body or a colspan change under one header changes the shape', () => {
  const headers = ['Model', 'Date']
  const known = htmlTable(headers, [['m', 'd']])
  strictAssert.deepEqual(htmlTableShapes(known), ['model | date [2 cols]'])
  strictAssert.deepEqual(htmlTableShapes(`<h3>2026-09-01</h3>${known}<h3>2026-11-01</h3>${htmlTable(headers, [['n', 'e'], ['o', 'f']])}`), ['model | date [2 cols]'])
  strictAssert.deepEqual(htmlTableShapes(htmlTable(headers, [['m', 'd', 'note']])), ['model | date [3 cols]'])
  const spanned = '<table><thead><tr><th colspan="2">Model</th><th>Date</th></tr></thead><tr><td>m</td><td>x</td><td>d</td></tr></table>'
  strictAssert.deepEqual(htmlTableShapes(spanned), ['model | date [3 cols]'])
  const markdown = rows => `## A\n${markdocTable(['Model', 'Date'], rows)}\n`
  strictAssert.deepEqual(markdocTableShapes(markdown([['`m`', 'd']])), ['model | date [2 cols]'])
  strictAssert.deepEqual(markdocTableShapes(`${markdown([['`m`', 'd']])}## B\n${markdocTable(['Model', 'Date'], [['`n`', 'e']])}\n`), ['model | date [2 cols]'])
  strictAssert.deepEqual(markdocTableShapes(markdown([['`m`', 'd', 'extra']])), ['model | date [3 cols]'])
})

test('footnote markers in header cells are dropped, so adding or renumbering one does not change the shape', () => {
  const shape = label => htmlTableShapes(htmlTable(['Model', label]))
  strictAssert.deepEqual(shape('Retirement date<sup>1</sup>'), ['model | retirement date [2 cols]'])
  strictAssert.deepEqual(shape('Retirement date<sup class="fn"><a href="#n2">2</a></sup>'), shape('Retirement date'))
  strictAssert.deepEqual(markdocTableShapes(`## A\n${markdocTable(['Model', 'Shutdown date<sup>3</sup>'], [['`m`', 'd']])}\n`), ['model | shutdown date [2 cols]'])
})

test('custom elements whose names start with table or a cell tag are not read as tables', () => {
  const page = `<table-wrapper class="scroll">${htmlTable(['Model', 'Date'])}</table-wrapper><table-of-contents><p>x</p></table-of-contents>`
  strictAssert.deepEqual(htmlTableShapes(page), ['model | date [2 cols]'])
  const custom = '<table><thead><tr><th>Model</th><th-sort>ignored</th-sort></tr></thead><tr-group></tr-group><tr><td>m</td></tr></table>'
  strictAssert.deepEqual(htmlTableShapes(custom), ['model [1 cols]'])
  strictAssert.throws(() => htmlTableShapes('<table-wrapper><table><tr><th>Open</th></tr></table-wrapper>'), /unbalanced <table> tag/)
})

test('Markdoc header rows are read with emphasis, links, and escapes removed, and model and agent tables stay distinct', () => {
  const markdown = [
    '# Gemini deprecations',
    '## Gemini 3 models {% id="gemini-3" %}',
    markdocTable(['**Model**', 'Release\u00a0date', '[Shutdown date](/docs/x)', '_Recommended_ replacement'], [['`gemini-a`', 'May 1, 2026', 'June 1, 2026', '']]),
    '## Gemini 2 models',
    markdocTable(['Model', 'Release date', 'Shutdown date', 'Recommended replacement'], [['`gemini-b`', 'May 1, 2025', 'June 1, 2026', '']]),
    '## Agents',
    markdocTable(['Agent', 'Release date', 'Shutdown date', 'Recommended replacement'], [['`agent-a`', 'May 1, 2025', 'June 1, 2026', '']]),
    '```',
    markdocTable(['Fenced', 'Example'], [['x', 'y']]),
    '```',
  ].join('\n')
  strictAssert.deepEqual(markdocTableShapes(markdown), [
    'agent | release date | shutdown date | recommended replacement [4 cols]',
    'model | release date | shutdown date | recommended replacement [4 cols]',
  ])
  strictAssert.throws(() => markdocTableShapes('## A\n{% table %}\n  * Model\n'), /not closed/)
  strictAssert.throws(() => markdocTableShapes('## A\n{% table id="x" %}\n'), /malformed table tag/)
})

test('snapshot comparison reports added and removed shapes, new and removed sources, and moved URLs', () => {
  const before = snapshotDocument({ a: { url: 'https://a.test/', tables: ['x | y'] }, gone: { url: 'https://gone.test/', tables: ['z'] } })
  const after = snapshotDocument({ a: { url: 'https://a.test/moved', tables: ['x | y | notice date'] }, fresh: { url: 'https://fresh.test/', tables: ['q'] } })
  const changes = compareShapes(before, after)
  strictAssert.deepEqual(changes.map(change => [change.name, change.status, change.previousUrl, change.added, change.removed]), [
    ['a', undefined, 'https://a.test/', ['x | y | notice date'], ['x | y']],
    ['fresh', 'new source', undefined, ['q'], []],
    ['gone', 'source removed', undefined, [], ['z']],
  ])
  strictAssert.deepEqual(compareShapes(before, before), [])
  const markdown = renderShapeDiff(changes)
  strictAssert.ok(markdown.includes('## a\n\nSource: https://a.test/moved\nPrevious source: https://a.test/') && markdown.includes('- `x | y | notice date`'))
})

test('the committed snapshot is a valid snapshot covering exactly the configured sources', () => {
  const snapshot = readSnapshot(SNAPSHOT_FILE)
  const expected = Object.fromEntries(shapeSources().map(source => [source.name, source.url]))
  const actual = Object.fromEntries(Object.entries(snapshot.sources).map(([name, source]) => [name, source.url]))
  strictAssert.deepEqual(actual, expected)
  strictAssert.ok(Object.values(snapshot.sources).every(source => source.tables.length > 0 && source.tables.join() === [...source.tables].sort().join()))
  strictAssert.equal(fs.readFileSync(SNAPSHOT_FILE, 'utf8'), `${JSON.stringify(snapshotDocument(snapshot.sources), null, 2)}\n`)
})

const fixtureDir = path.join(tempRoot, 'fixtures')
const snapshotFile = path.join(tempRoot, 'source-shapes.json')
const cohereHeaders = ['Shutdown Date', 'Deprecated Model', 'Recommended Replacement']
const fixtureFiles = {
  'openai-deprecations.html': htmlTable(['Shutdown date', 'Affected model', 'Recommended replacement']),
  'anthropic-deprecations.html': htmlTable(['Retirement date', 'Deprecated model', 'Recommended replacement']),
  'google-deprecations.md': `## Models\n${markdocTable(['Model', 'Release date', 'Shutdown date', 'Recommended replacement'], [['`gemini-a`', 'a', 'b', '']])}\n`,
  'mistral-deprecations.html': htmlTable(['Model', 'Version', 'API', 'Deprecation', 'Alternative']),
  'cohere-deprecations.html': `<h3>2026-09-01</h3>${htmlTable(cohereHeaders)}<h3>2026-10-01</h3>${htmlTable(cohereHeaders)}`,
  'bedrock-lifecycle.html': htmlTable(['Model ID', 'Legacy date', 'EOL date']),
  'vertex-model-versions.html': htmlTable(['Model ID', 'Release date', 'Retirement date']),
  'azure-model-retirement-schedule.html': htmlTable(['Model', 'Version', 'Retirement date']),
}
const writeFixtures = (overrides = {}) => {
  fs.rmSync(fixtureDir, { recursive: true, force: true })
  fs.mkdirSync(fixtureDir, { recursive: true })
  for (const [name, body] of Object.entries({ ...fixtureFiles, ...overrides })) if (body !== null) fs.writeFileSync(path.join(fixtureDir, name), body)
}

test('--write --fixtures refuses to replace the committed snapshot', () => {
  writeFixtures()
  const result = run(['--write', '--fixtures', fixtureDir])
  strictAssert.equal(result.code, 1)
  strictAssert.match(result.err, /needs an explicit --snapshot/)
})

test('a snapshot written from the sources makes --check exit 0', () => {
  writeFixtures()
  strictAssert.equal(run(['--write', '--fixtures', fixtureDir, '--snapshot', snapshotFile]).code, 0)
  const written = readSnapshot(snapshotFile)
  strictAssert.deepEqual(Object.keys(written.sources), shapeSources().map(source => source.name).sort())
  strictAssert.deepEqual(written.sources.cohere.tables, ['shutdown date | deprecated model | recommended replacement [3 cols]'])
  const result = run(['--check', '--fixtures', fixtureDir, '--snapshot', snapshotFile])
  strictAssert.equal(result.code, 0, result.err)
  strictAssert.match(result.out, /All 8 source pages match/)
})

test('a new column makes --check exit 3 with a diff naming the source and both shapes', () => {
  writeFixtures({ 'cohere-deprecations.html': `<h3>2026-09-01</h3>${htmlTable(cohereHeaders)}<h3>2026-11-01</h3>${htmlTable([...cohereHeaders, 'Notice\u200b Date'])}` })
  const result = run(['--check', '--fixtures', fixtureDir, '--snapshot', snapshotFile])
  strictAssert.equal(result.code, 3, result.err)
  strictAssert.ok(result.out.startsWith('# Source page structure diff\n'))
  strictAssert.ok(result.out.includes('## cohere\n\nSource: https://docs.cohere.com/docs/deprecations'))
  strictAssert.ok(result.out.includes('Header shapes added:\n\n- `shutdown date | deprecated model | recommended replacement | notice date [4 cols]`'))
  strictAssert.ok(!result.out.includes('Header shapes removed'))
  strictAssert.ok(!/## (?!cohere)/.test(result.out))
  writeFixtures({ 'cohere-deprecations.html': htmlTable([...cohereHeaders, 'Notice Date']) })
  const replaced = run(['--check', '--fixtures', fixtureDir, '--snapshot', snapshotFile])
  strictAssert.equal(replaced.code, 3)
  strictAssert.ok(replaced.out.includes('Header shapes removed:\n\n- `shutdown date | deprecated model | recommended replacement [3 cols]`'))
})

test('failing sources make --check exit 1 and every failing source is named', () => {
  writeFixtures({
    'mistral-deprecations.html': '<p>No tables here.</p>',
    'vertex-model-versions.html': null,
    'google-deprecations.md': '## Models\n{% table %}\n  * Model\n',
    'cohere-deprecations.html': htmlTable([...cohereHeaders, 'Notice Date']),
  })
  const result = run(['--check', '--fixtures', fixtureDir, '--snapshot', snapshotFile])
  strictAssert.equal(result.code, 1)
  strictAssert.equal(result.out, '')
  for (const [name, reason] of [['google', /not closed/], ['mistral', /no tables found/], ['vertex-ai', /missing vertex-ai fixture/]]) {
    strictAssert.match(result.err, new RegExp(`source shape check failed for ${name} \\(https://[^)]+\\): [^\\n]*${reason.source}`))
  }
  strictAssert.ok(!result.err.includes('for cohere'))
})

test('a missing or malformed snapshot is a failure, not a match', () => {
  writeFixtures()
  const missing = run(['--check', '--fixtures', fixtureDir, '--snapshot', path.join(tempRoot, 'absent.json')])
  strictAssert.equal(missing.code, 1)
  strictAssert.match(missing.err, /cannot read source shape snapshot/)
  fs.writeFileSync(path.join(tempRoot, 'bad.json'), '{"version":1,"sources":{"a":{"url":"x","tables":[1]}}}')
  strictAssert.equal(run(['--check', '--fixtures', fixtureDir, '--snapshot', path.join(tempRoot, 'bad.json')]).code, 1)
  strictAssert.equal(run(['--fixtures', fixtureDir]).code, 1)
})

test('the daily source-check workflow runs both refresh checks and the structure check, read-only, with durable issues', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'source-check.yml'), 'utf8')
  const cron = workflow.match(/cron: '(\d+) (\d+) \* \* \*'/)
  strictAssert.ok(cron && cron[1] !== '0' && workflow.includes('workflow_dispatch:'), 'daily schedule off the hour plus manual dispatch')
  strictAssert.ok(/^name: source-check$/m.test(workflow) && !/^name: feed-refresh$/m.test(workflow) && workflow.includes('group: source-check'), 'own name and concurrency group')
  strictAssert.ok(workflow.includes('contents: read') && workflow.includes('issues: write') && !/contents: write|pull-requests: write/.test(workflow), 'read-only contents')
  strictAssert.ok(!/git (push|commit)|gh pr /.test(workflow) && workflow.includes('persist-credentials: false'), 'writes nothing to the repository')
  strictAssert.ok(workflow.includes('check_once_more provider node refresh/refresh.mjs --check\n') && workflow.includes('check_once_more distributor node refresh/refresh.mjs --distributor aws-bedrock,vertex-ai,azure-ai-foundry --check\n'), 'both refresh checks')
  strictAssert.ok(workflow.match(/sleep 60/g)?.length === 2 && workflow.match(/node refresh\/shapes\.mjs --check > shapes-diff\.md 2> shapes-err\.txt/g)?.length === 2, 'an unhealthy check is retried once')
  strictAssert.ok(/^    timeout-minutes: 30$/m.test(workflow) && !workflow.includes('always()') && workflow.match(/if: success\(\) \|\| failure\(\)/g)?.length === 2, 'a cancelled run reports nothing')
  strictAssert.ok(workflow.includes("case \"$1\" in 0|3) echo ok ;;") && workflow.includes("s/(HTTP [0-9]{3}).*/\\1/"), 'failure state ignores healthy exit-code flips and HTTP response bodies')
  strictAssert.ok(workflow.includes('if [ "${REFRESH_HEALTHY:-}" != true ]; then') && workflow.includes('the weekly feed refresh is not affected'), 'a structure-check-only failure does not claim the weekly refresh will fail')
  strictAssert.ok(workflow.includes('[ "$providers" -ne 0 ] && [ "$providers" -ne 3 ]') && workflow.includes('[ "$distributors" -ne 0 ] && [ "$distributors" -ne 3 ]'), 'refresh exit 0 and 3 are healthy')
  strictAssert.ok(workflow.includes('node refresh/shapes.mjs --check >') && workflow.includes('case "$SHAPES" in 0|3)'), 'structure check, exit 3 is not a failure')
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY']) strictAssert.ok(workflow.includes(`${key}: \${{ secrets.${key} }}`), key)
  strictAssert.ok(workflow.includes('failed_title="Source check failed"') && workflow.includes('shapes_title="Source page structure changed"'), 'both issue titles')
  strictAssert.ok(workflow.includes('--label model-eol; then') && workflow.includes('gh issue close "$issue" --reason completed'), 'label fallback and recovery close')
  strictAssert.ok(workflow.includes('node refresh/shapes.mjs --write') && workflow.includes('already reports this state'), 'issue tells how to update the snapshot and avoids repeat comments')
})

test('the public contract does not react to the source check', () => {
  const publicWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'public-contract.yml'), 'utf8')
  strictAssert.ok(publicWorkflow.includes('workflows: [feed-refresh]') && !publicWorkflow.includes('source-check'))
})

fs.rmSync(tempRoot, { recursive: true, force: true })
if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nsource shape tests passed')
