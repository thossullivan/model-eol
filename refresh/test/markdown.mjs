#!/usr/bin/env node
// Offline tests for the GFM pipe-table reader.
import fs from 'node:fs'
import path from 'node:path'
import strictAssert from 'node:assert/strict'
import { markdownCellHtml, markdownPipeTables, markdownPipeTableToHtml, splitPipeRow } from '../markdown.mjs'
import { htmlTableShapes, pipeTableShapes } from '../shapes.mjs'

const fixtureDir = path.join(import.meta.dirname, 'fixture', 'pipe-tables')
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

const doc = lines => lines.join('\n')

test('a header, an aligned delimiter row, and body rows make one table with its line and heading', () => {
  const tables = markdownPipeTables(doc([
    '# Deprecations',
    '',
    'Intro | with a pipe in prose.',
    '',
    '## Upcoming',
    '',
    '| Shutdown date | Model | Replacement |',
    '| :------------ | :---: | ----------: |',
    '| 2026-12-01    | `a`   | b           |',
    '| 2027-01-01    | `c`   |             |',
    '',
    'Model | Date',
    '--- | ---',
    'x | y',
  ]))
  strictAssert.deepEqual(tables, [
    { header: ['Shutdown date', 'Model', 'Replacement'], rows: [['2026-12-01', '`a`', 'b'], ['2027-01-01', '`c`', '']], line: 7, heading: 'Upcoming' },
    { header: ['Model', 'Date'], rows: [['x', 'y']], line: 12, heading: 'Upcoming' },
  ])
  strictAssert.deepEqual(markdownPipeTables('| Only |\n| --- |\n'), [{ header: ['Only'], rows: [], line: 1, heading: undefined }])
})

test('escaped pipes are unescaped inside a cell and an escaped backslash before a pipe still separates', () => {
  strictAssert.deepEqual(splitPipeRow('| a \\| b | c |'), ['a | b', 'c'])
  strictAssert.deepEqual(splitPipeRow('| a \\\\| b |'), ['a \\\\', 'b'])
  strictAssert.deepEqual(splitPipeRow('| a | b \\|'), ['a', 'b |'])
  strictAssert.deepEqual(splitPipeRow('a | | c'), ['a', '', 'c'])
  strictAssert.equal(splitPipeRow('no pipe here'), undefined)
})

test('pipes inside code spans are not separators, and an unclosed backtick is literal', () => {
  strictAssert.deepEqual(splitPipeRow('| `a|b` | ``x ` | y`` | c |'), ['`a|b`', '``x ` | y``', 'c'])
  strictAssert.deepEqual(splitPipeRow('| `a\\|b` | c |'), ['`a|b`', 'c'])
  strictAssert.deepEqual(splitPipeRow('| `open | c |'), ['`open', 'c'])
  strictAssert.deepEqual(markdownPipeTables('| A | B |\n|---|---|\n| `x|y` | z |')[0].rows, [['`x|y`', 'z']])
})

test('tables in fenced code, comments, and front matter are ignored without shifting line numbers', () => {
  const tables = markdownPipeTables(doc([
    '---',
    'title: Page | Site',
    '---',
    '```markdown',
    '| Fenced | Example |',
    '| --- |',
    '```',
    '~~~~',
    '| Tilde | Fence |',
    '~~~~',
    '<!--',
    '| Commented | Out |',
    '| --- | --- |',
    '-->',
    '### Real',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
  ]))
  strictAssert.deepEqual(tables, [{ header: ['A', 'B'], rows: [['1', '2']], line: 16, heading: 'Real' }])
})

test('a delimiter or body row with a different cell count throws with its line', () => {
  strictAssert.throws(() => markdownPipeTables('# T\n\n| A | B |\n| --- |\n'), /^Error: line 4: table delimiter row has 1 cells; the header has 2$/)
  strictAssert.throws(() => markdownPipeTables('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 2026-12-01 |\n'), /^Error: line 4: table row has 1 cells; the header has 2$/)
  strictAssert.throws(() => markdownPipeTables('| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n'), /line 3: table row has 3 cells/)
  strictAssert.throws(() => markdownPipeTables('| A | B |\n| --- | --- |\n| 1 | 2 |\nloose text\n'), /line 4: line without a pipe directly follows a table row/)
  strictAssert.throws(() => markdownPipeTables('| A | B |\n| --- | --- |\n| 1 | 2 |\n|---|---|\n'), /line 4: table has a second delimiter row/)
})

test('a delimiter row without a header and a row cut off from its table by a blank line throw', () => {
  strictAssert.throws(() => markdownPipeTables('Intro\n\n| --- | --- |\n'), /^Error: line 3: table delimiter row has no header row$/)
  strictAssert.throws(() => markdownPipeTables('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4 |\n'), /^Error: line 5: table row outside a table$/)
})

test('headings end a table and set the heading of later tables; closing hashes and quote markers are dropped', () => {
  const tables = markdownPipeTables(doc([
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '## Next section ##',
    '> | Quoted | Table |',
    '> | --- | --- |',
    '> | q | t |',
    '>',
    '#### The following table lists the retired models (click to expand)',
    '| C |',
    '| - |',
    '| 3 |',
    '<br />',
  ]))
  strictAssert.deepEqual(tables.map(table => [table.line, table.heading, table.header]), [
    [1, undefined, ['A', 'B']],
    [5, 'Next section', ['Quoted', 'Table']],
    [10, 'The following table lists the retired models (click to expand)', ['C']],
  ])
})

test('the default cell HTML keeps code, links, and <br>, drops emphasis, and escapes other markup', () => {
  strictAssert.equal(markdownCellHtml('**Dec 1, 2026**'), 'Dec 1, 2026')
  strictAssert.equal(markdownCellHtml('`a<b>&c`'), '<code>a&lt;b&gt;&amp;c</code>')
  strictAssert.equal(markdownCellHtml('[`gpt-5`](/models/gpt-5 ) or [*docs*](https://x.test/a?b=1&c="2")'), '[<code>gpt-5</code>](/models/gpt-5 ) or <a href="https://x.test/a?b=1&amp;c=&quot;2&quot;">docs</a>')
  strictAssert.equal(markdownCellHtml('[`gpt-5`](/models/gpt-5)'), '<a href="/models/gpt-5"><code>gpt-5</code></a>')
  strictAssert.equal(markdownCellHtml('[click](javascript:alert(1)) [x](javascript:void)'), '[click](javascript:alert(1)) x')
  strictAssert.equal(markdownCellHtml('one<br>two<BR />three'), 'one<br>two<br>three')
  strictAssert.equal(markdownCellHtml('<script>x</script> <sup>1</sup> AT&T &amp; &#8212; a < b'), '&lt;script&gt;x&lt;/script&gt; &lt;sup&gt;1&lt;/sup&gt; AT&amp;T &amp; &#8212; a &lt; b')
  strictAssert.equal(markdownCellHtml('snake_case_id _em_ \\*star\\* \\`tick\\` \\[x](y)'), 'snake_case_id em *star* `tick` [x](y)')
  strictAssert.equal(markdownCellHtml('`` a `b` ``'), '<code>a `b`</code>')
})

test('a table renders as thead and tbody HTML, and a custom cellHtml sees each cell position', () => {
  const [table] = markdownPipeTables('| Model | Date |\n|---|---|\n| `m<1>` | **2026-12-01** |\n')
  strictAssert.equal(markdownPipeTableToHtml(table), '<table><thead><tr><th>Model</th><th>Date</th></tr></thead><tbody><tr><td><code>m&lt;1&gt;</code></td><td>2026-12-01</td></tr></tbody></table>')
  const seen = []
  markdownPipeTableToHtml(table, { cellHtml: (text, where) => { seen.push([text, where]); return 'x' } })
  strictAssert.deepEqual(seen, [
    ['Model', { row: -1, column: 0, header: true }],
    ['Date', { row: -1, column: 1, header: true }],
    ['`m<1>`', { row: 0, column: 0, header: false }],
    ['**2026-12-01**', { row: 0, column: 1, header: false }],
  ])
})

test('every recorded Markdown source page parses, and its HTML rendering has the same header shapes', () => {
  const expected = {
    'anthropic-deprecations.md': 12,
    'azure-ai-foundry-retirement-schedule.md': 19,
    'mistral-models.md': 2,
    'openai-deprecations.md': 4,
    'vertex-ai-model-versions.md': 7,
  }
  strictAssert.deepEqual(fs.readdirSync(fixtureDir).sort(), Object.keys(expected).sort())
  for (const [name, count] of Object.entries(expected)) {
    const markdown = fs.readFileSync(path.join(fixtureDir, name), 'utf8')
    const tables = markdownPipeTables(markdown)
    strictAssert.equal(tables.length, count, name)
    strictAssert.ok(tables.every(table => table.heading && table.rows.length && table.rows.every(row => row.length === table.header.length)), name)
    strictAssert.deepEqual(htmlTableShapes(tables.map(table => markdownPipeTableToHtml(table)).join('\n')), pipeTableShapes(markdown), name)
  }
})

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nmarkdown table tests passed')
