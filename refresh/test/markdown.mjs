#!/usr/bin/env node
// Offline tests for the GFM pipe-table reader.
import fs from 'node:fs'
import path from 'node:path'
import strictAssert from 'node:assert/strict'
import {
  headingHtml,
  htmlTableLineIndex,
  isHtmlBody,
  isSetextUnderline,
  MARKDOWN_THEMATIC_BREAK,
  markdownCellHtml,
  markdownHeading,
  markdownInlineText,
  markdownLines,
  markdownPage,
  markdownPipeTables,
  markdownPipeTableToHtml,
  splitPipeRow,
} from '../markdown.mjs'
import { htmlTableShapes, pipeTableShapes } from '../shapes.mjs'
import { parseAzureModelRetirementScheduleMarkdown, parseVertexModelVersionsMarkdown } from '../distributors.mjs'

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

test('markdownPage lines keep the table reader\'s line numbers through BOM, CRLF, front matter, fences, comments, and quotes', () => {
  const markdown = '\uFEFF---\r\ntitle: x\r\n---\r\n```\r\n# fenced\r\n```\r\n<!-- a\r\nb -->\r\n> ## Quoted\r\n> | A |\r\n> | - |\r\n> | 1 |\r\n'
  const page = markdownPage(markdown)
  strictAssert.deepEqual(page.lines, ['', '', '', '', '', '', '', '', '## Quoted', '| A |', '| - |', '| 1 |', ''])
  strictAssert.deepEqual(page.tables, markdownPipeTables(markdown))
  strictAssert.deepEqual([...page.tableAt.keys()], [9])
  strictAssert.equal(page.tableAt.get(9).heading, 'Quoted')
  strictAssert.deepEqual(markdownLines('> # Q\n> text', { unquote: false }), ['> # Q', '> text'])
  strictAssert.throws(() => markdownPage(1), /markdown must be a string/)
})

test('shared block checks match ATX headings, setext underlines, thematic breaks, raw tables, and HTML bodies', () => {
  strictAssert.deepEqual(markdownHeading('  ## Title ##  '), { level: 2, text: 'Title' })
  strictAssert.deepEqual(markdownHeading('#'), { level: 1, text: '' })
  strictAssert.equal(markdownHeading('#Title'), undefined)
  strictAssert.equal(markdownHeading('    # code'), undefined)
  strictAssert.equal(headingHtml({ level: 3 }, 'x'), '<h3>x</h3>')
  strictAssert.ok(['===', '  -', '---  '].every(isSetextUnderline))
  strictAssert.ok(!['    ---', '=-', '- x'].some(isSetextUnderline))
  strictAssert.ok(['***', ' - - -', '___'].every(line => MARKDOWN_THEMATIC_BREAK.test(line)))
  strictAssert.ok(!['-*-', '--', '    ***'].some(line => MARKDOWN_THEMATIC_BREAK.test(line)))
  strictAssert.equal(htmlTableLineIndex(['a', 'x <TABLE class="y">', '<table>']), 1)
  strictAssert.equal(htmlTableLineIndex(['<tables>']), -1)
  strictAssert.ok(isHtmlBody('\uFEFF\n<!-- a --><!DOCTYPE html>'))
  strictAssert.ok(!isHtmlBody('# Models\n<table></table>'))
})

test('S1: an unmatched * or _ stays literal, so a footnote marker survives; matched emphasis is still dropped', () => {
  for (const [source, text] of [
    ['2027-06-01*', '2027-06-01*'],
    ['November 30, 2026*', 'November 30, 2026*'],
    ['*Dec 1, 2026', '*Dec 1, 2026'],
    ['gemini-a_', 'gemini-a_'],
    ['a * b', 'a * b'],
    ['**x*', '*x'],
    ['*Note:* see **Dec 1, 2026**', 'Note: see Dec 1, 2026'],
    ['__init__ and _em_ and snake_case_id', 'init and em and snake_case_id'],
    ['**`gpt-5`**', '<code>gpt-5</code>'],
    ['*[docs](/a)*', '<a href="/a">docs</a>'],
  ]) strictAssert.equal(markdownCellHtml(source), text, source)
  strictAssert.equal(markdownInlineText('2025-04-30*'), '2025-04-30*')
  strictAssert.equal(markdownInlineText('**2025-04-30**'), '2025-04-30')
})

test('S2: struck-through text in Markdown or raw HTML is refused; a lone tilde and code are not', () => {
  for (const source of ['~~Jan 5, 2027~~ **Dec 1, 2026**', '~Jan 5, 2027~ Dec 1, 2026', '~~2026-10-31~~', '`a` ~~b `c` d~~', '<s>Jan 1, 2027</s> Dec 2, 2026', '<DEL>x</DEL>', '<strike class="old">x</strike>']) {
    strictAssert.throws(() => markdownCellHtml(source), /struck-through text in Markdown is refused/, source)
  }
  strictAssert.throws(() => markdownInlineText('~~2026-10-31~~'), /struck-through/)
  strictAssert.equal(markdownCellHtml('~50 models, a ~ b, ~~~ and `~~x~~`'), '~50 models, a ~ b, ~~~ and <code>~~x~~</code>')
})

test('S3: tables an indented code block, a quoted fence, or a comment would hide are refused or blanked as CommonMark renders them', () => {
  const table = ['| A | B |', '| - | - |', '| 1 | 2 |']
  strictAssert.throws(() => markdownPipeTables(doc(['Example:', '', ...table.map(line => `    ${line}`)])), /^Error: line 3: table indented 4 or more spaces renders as code/)
  strictAssert.throws(() => markdownPipeTables(doc(table.map(line => `\t${line}`))), /table indented 4 or more spaces/)
  strictAssert.deepEqual(markdownPipeTables(doc(['> ```', ...table.map(line => `> ${line}`), '>', '> ```', ...table])).map(found => found.line), [7])
  strictAssert.deepEqual(markdownPipeTables(doc(['> ```', '> x', 'lazy line ends the quote and its fence', ...table])).map(found => found.line), [4])
  strictAssert.deepEqual(markdownPipeTables(doc(['```', '> ```', ...table, '```', ...table])).map(found => found.line), [7])
  strictAssert.deepEqual(markdownPipeTables(doc(['```', 'x', '    ```', ...table, '```'])), [])
  strictAssert.deepEqual(markdownPipeTables(doc(['```', 'x', '   ```', ...table])).map(found => found.line), [4])
  strictAssert.deepEqual(markdownPipeTables(doc(['- item', '  ```', '  x', '  ```', ...table])).map(found => found.line), [5])
  strictAssert.throws(() => markdownPipeTables(doc(['- item', '  ```', '  x', '     ```', ...table])), /^Error: line 4: closing code fence indentation is ambiguous$/)
  strictAssert.throws(() => markdownPipeTables(doc(['- item', '  ```', '  x', '```', ...table])), /^Error: line 4: closing code fence indentation is ambiguous$/)
  strictAssert.throws(() => markdownPipeTables(doc(['- item', '  ```', 'x', '  ```'])), /^Error: line 3: code fence content is indented less than its opening fence$/)
  strictAssert.throws(() => markdownPipeTables(doc(['Text', '', '    ```', ...table])), /^Error: line 3: code fence indented 4 or more spaces$/)
  strictAssert.deepEqual(markdownPipeTables(doc(['```js `x`', ...table])).map(found => found.line), [2])
  strictAssert.throws(() => markdownPipeTables(doc([...table, '', '<!-- draft below', '', ...table])), /^Error: line 5: unbalanced comment marker: an unclosed HTML comment hides the rest of the page$/)
  strictAssert.throws(() => markdownPipeTables(doc(['| A | B |', '| - | - |', '| 1 | `<!--` |', '', ...table, '', 'more `-->`'])), /^Error: line 3: HTML comment marker inside a code span$/)
  strictAssert.throws(() => markdownPipeTables(doc(['a `x', '<!--` b', '', '<!-- real -->'])), /HTML comment marker inside a code span/)
  strictAssert.deepEqual(markdownPipeTables(doc(['<!-- a `b` -->', ...table])).map(found => found.line), [2])
  for (const hidden of ['<div hidden>', '<details hidden="">', '<span style="display: none">']) {
    strictAssert.throws(() => markdownPipeTables(doc([hidden, '', ...table])), /^Error: line 1: HTML element hidden from the rendered page$/, hidden)
  }
})

test('S4: a table row that starts with block or HTML markup but carries pipes is refused instead of dropped', () => {
  for (const row of ['<s>Jan 1, 2027</s> Dec 2, 2026 | 3', '<b>1</b> | 2', '- 1 | 2', '## 1 | 2']) {
    strictAssert.throws(() => markdownPipeTables(doc(['| A | B |', '| - | - |', '| 1 | 2 |', row])), /^Error: line 4: table row starts with block or HTML markup$/, row)
  }
  strictAssert.deepEqual(markdownPipeTables(doc(['| A | B |', '| - | - |', '| 1 | 2 |', '<br />']))[0].rows, [['1', '2']])
})

test('S5: bare inline phrasing tags render as tags so text readers see the words; attributes, unknown tags, and strike tags do not pass', () => {
  strictAssert.equal(markdownCellHtml('Retirement is <b>no earlier</b> than this date.'), 'Retirement is <b>no earlier</b> than this date.')
  strictAssert.equal(markdownCellHtml('<em>subject</em> to <SPAN>change</SPAN> <strong>x</strong>'), '<em>subject</em> to <span>change</span> <strong>x</strong>')
  strictAssert.equal(markdownCellHtml('<span class="x">no earlier</span> than <sup>3</sup> <table>'), '&lt;span class=&quot;x&quot;&gt;no earlier</span> than &lt;sup&gt;3&lt;/sup&gt; &lt;table&gt;')
  strictAssert.equal(markdownCellHtml('<b>*x*</b>'), '<b>x</b>')
})

test('S6: a backslash hard line break reads as whitespace, and a table cell that ends in a backslash is refused', () => {
  strictAssert.equal(markdownCellHtml('no earlier\\\nthan'), 'no earlier \nthan')
  strictAssert.equal(markdownCellHtml('may be\\'), 'may be ')
  strictAssert.equal(markdownCellHtml('a \\\\ b \\* c'), 'a \\ b * c')
  const [table] = markdownPipeTables('| A | B |\n| - | - |\n| 2026-10-31\\ | x |\n| y\\\\ | z |\n')
  strictAssert.throws(() => markdownPipeTableToHtml(table), /^Error: line 3: table cell ends with a backslash: 2026-10-31\\$/)
  strictAssert.ok(markdownPipeTableToHtml({ ...table, rows: table.rows.slice(1) }).includes('<td>y\\</td>'))
})

test('S5 and S6 through the shared reader: Azure and Vertex see precision wording split by inline tags or a hard line break', () => {
  const azure = after => `# T\n\n## G\n\n### Azure OpenAI\n\n| Model | Version | Lifecycle | Retirement date | Replacement |\n| --- | --- | --- | --- | --- |\n| gpt-4o | 2024-08-06 | Deprecated | 2027-04-14^3^ | - |\n\n${after}`
  for (const note of ['Retirement is <b>no earlier</b> than this date.', 'Retirement is <span>no earlier</span> than this date.', 'This date is <em>subject</em> to change.', 'Retirement no earlier\\\nthan this date.']) {
    strictAssert.throws(() => parseAzureModelRetirementScheduleMarkdown(azure(`^3^ April 14, 2027 applies. ${note}\n`), { now: new Date('2026-11-17') }), /retirement footnote 3 makes the date approximate/, note)
  }
  const vertex = prose => parseVertexModelVersionsMarkdown(`## Latest\n\n${prose}\n\n| Model ID | Release date | Retirement date | Replacement model ID |\n|---|---|---|---|\n| \`gemini-a\` | May 1, 2025 | October 20, 2026 |   |\n`)
  for (const prose of ['While retirement timelines may be\\\nextended, they won\'t move.', 'Retirement dates are the <b>earliest</b> possible dates.']) {
    strictAssert.deepEqual(vertex(prose), [{ vertexId: 'gemini-a', shutdown: '2026-10-20', date_precision: 'earliest' }], prose)
  }
})

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nmarkdown table tests passed')
