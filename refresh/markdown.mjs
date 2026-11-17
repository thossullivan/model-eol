// Strict Markdown line preparation, GFM pipe tables, and block helpers for provider documentation pages.

export const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const MARKDOWN_ESCAPABLE = /[!-/:-@[-`{-~]/

/** Blank every line of each fenced code block, fences included, so line numbers survive. */
export function stripFencedCodeBlocks(markdown) {
  let fence
  return markdown.split(/\r?\n/).map(line => {
    if (fence) {
      const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/)
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = undefined
      return ''
    }
    const opening = line.match(/^\s*(`{3,}|~{3,})/)
    if (!opening) return line
    fence = opening[1]
    return ''
  }).join('\n')
}

// Drops Markdown emphasis and backslash escapes; an underscore inside a word is kept.
export function markdownInlineText(text) {
  let output = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\' && MARKDOWN_ESCAPABLE.test(text[index + 1] ?? '')) output += text[++index]
    else if (char === '~' && text[index + 1] === '~') index++
    else if (char === '_' && !(/[\p{L}\p{N}]/u.test(text[index - 1] ?? '') && /[\p{L}\p{N}]/u.test(text[index + 1] ?? ''))) continue
    else if (char !== '*') output += char
  }
  return output
}

const blankKeepingLines = match => match.replace(/[^\n]/g, '')

function stripFrontMatter(text) {
  const match = text.match(/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?=\n|$)/)
  return match ? blankKeepingLines(match[0]) + text.slice(match[0].length) : text
}

export function stripCommentsKeepingLines(text) {
  let output = text
  const pattern = /<!--[\s\S]*?--!?>/g
  while (pattern.test(output)) output = output.replace(pattern, blankKeepingLines)
  return output
}

const codeSpanEnd = (text, start, ticks) => {
  for (let index = start; index < text.length;) {
    if (text[index] !== '`') {
      index++
      continue
    }
    let end = index
    while (text[end] === '`') end++
    if (end - index === ticks) return end
    index = end
  }
  return -1
}

/** Split one table line into trimmed cell source; returns undefined when it has no unescaped pipe outside a code span. */
export function splitPipeRow(line) {
  const text = line.trim()
  const cells = []
  let cell = ''
  let pipes = 0
  let trailing = false
  for (let index = 0; index < text.length;) {
    trailing = false
    const char = text[index]
    if (char === '\\' && index + 1 < text.length) {
      cell += text[index + 1] === '|' ? '|' : text.slice(index, index + 2)
      index += 2
    } else if (char === '`') {
      let run = index
      while (text[run] === '`') run++
      const end = codeSpanEnd(text, run, run - index)
      const span = end < 0 ? text.slice(index, run) : text.slice(index, end)
      cell += span.replace(/\\\|/g, '|')
      index = end < 0 ? run : end
    } else if (char === '|') {
      cells.push(cell)
      cell = ''
      pipes++
      index++
      trailing = true
    } else {
      cell += char
      index++
    }
  }
  cells.push(cell)
  if (!pipes) return undefined
  if (text.startsWith('|')) cells.shift()
  if (trailing && cells.length) cells.pop()
  return cells.map(value => value.trim())
}

const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/
const isDelimiterRow = line => line.includes('|') && DELIMITER_ROW.test(line.trim())
export const MARKDOWN_ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
export const MARKDOWN_THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|<|(?:[-*_][ \t]*){3,}$)/

/** A body is HTML when its first markup, after any leading comments, is a tag. */
export const isHtmlBody = text => /^\s*(?:<!--[\s\S]*?--!?>\s*)*</.test(String(text).replace(/^\uFEFF/, ''))

/** True for a line that turns the paragraph above it into a setext heading. */
export const isSetextUnderline = line => /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)

/** Index of the first line with a raw HTML table tag, or -1. */
export const htmlTableLineIndex = lines => lines.findIndex(line => /<table\b/i.test(line))

/** An ATX heading line as { level, text } with the text untrimmed, or undefined. */
export function markdownHeading(line) {
  const match = line.match(MARKDOWN_ATX_HEADING)
  return match ? { level: match[1].length, text: match[2] ?? '' } : undefined
}

export const headingHtml = ({ level }, html) => `<h${level}>${html}</h${level}>`

/** Source lines with BOM, CRLF, front matter, fenced code, and comments blanked so line numbers survive; quote markers stripped unless unquote is false. */
export function markdownLines(markdown, { unquote = true } = {}) {
  const source = stripCommentsKeepingLines(stripFencedCodeBlocks(stripFrontMatter(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))))
  const lines = source.split('\n')
  return unquote ? lines.map(line => line.replace(/^\s*(?:>\s?)+/, '')) : lines
}

/** Every GFM pipe table in document order; throws on any table whose rows do not all match the header's cell count. */
export function markdownPipeTables(markdown) {
  return markdownPage(markdown).tables
}

/** The lines of markdownLines plus every pipe table, also keyed by the index of its header line. */
export function markdownPage(markdown) {
  if (typeof markdown !== 'string') throw new Error('markdown must be a string')
  const lines = markdownLines(markdown)
  const tables = pipeTablesInLines(lines)
  return { lines, tables, tableAt: new Map(tables.map(table => [table.line - 1, table])) }
}

function pipeTablesInLines(lines) {
  const tables = []
  let heading
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const number = index + 1
    if (!line.trim()) continue
    if (isDelimiterRow(line)) throw new Error(`line ${number}: table delimiter row has no header row`)
    const atx = line.match(MARKDOWN_ATX_HEADING)
    if (atx) {
      heading = (atx[2] ?? '').trim()
      continue
    }
    if (index + 1 < lines.length && isDelimiterRow(lines[index + 1])) {
      const header = splitPipeRow(line)
      if (!header) throw new Error(`line ${number}: table header row has no pipe`)
      const delimiter = splitPipeRow(lines[index + 1])
      if (delimiter.length !== header.length) {
        throw new Error(`line ${number + 1}: table delimiter row has ${delimiter.length} cells; the header has ${header.length}`)
      }
      const rows = []
      for (index += 2; index < lines.length; index++) {
        const row = lines[index]
        if (!row.trim() || BLOCK_START.test(row)) break
        if (isDelimiterRow(row)) throw new Error(`line ${index + 1}: table has a second delimiter row`)
        const cells = splitPipeRow(row)
        if (!cells) throw new Error(`line ${index + 1}: line without a pipe directly follows a table row`)
        if (cells.length !== header.length) {
          throw new Error(`line ${index + 1}: table row has ${cells.length} cells; the header has ${header.length}`)
        }
        rows.push(cells)
      }
      index--
      tables.push({ header, rows, line: number, heading })
      continue
    }
    if (line.trim().startsWith('|')) throw new Error(`line ${number}: table row outside a table`)
  }
  return tables
}

const ENTITY = /^&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/i
const SAFE_HREF = /^(?:https?:|mailto:|[/#?.]|[^:]*$)/i

const escapeText = text => text.replace(/&|<|>|"/g, (char, offset) => {
  if (char === '&') return ENTITY.test(text.slice(offset)) ? '&' : '&amp;'
  return { '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]
})

function inlineTokens(text, stopAtBracket = false) {
  const tokens = []
  let plain = ''
  const flush = () => {
    if (plain) tokens.push({ kind: 'text', value: plain })
    plain = ''
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\\' && MARKDOWN_ESCAPABLE.test(text[index + 1] ?? '')) {
      plain += text.slice(index, index + 2)
      index += 2
    } else if (char === '`') {
      let run = index
      while (text[run] === '`') run++
      const end = codeSpanEnd(text, run, run - index)
      if (end < 0) {
        plain += text.slice(index, run)
        index = run
        continue
      }
      flush()
      let code = text.slice(run, end - (run - index))
      if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1)
      tokens.push({ kind: 'code', value: code })
      index = end
    } else if (/^<br\s*\/?>/i.test(text.slice(index))) {
      flush()
      tokens.push({ kind: 'br' })
      index += text.slice(index).match(/^<br\s*\/?>/i)[0].length
    } else if (char === '[') {
      const inner = inlineTokens(text.slice(index + 1), true)
      const target = inner.end === undefined ? null : text.slice(index + 1 + inner.end + 1).match(/^\(([^()\s]*)\)/)
      if (!target) {
        plain += char
        index++
        continue
      }
      flush()
      tokens.push({ kind: 'link', href: target[1], children: inner.tokens })
      index += 1 + inner.end + 1 + target[0].length
    } else if (char === ']' && stopAtBracket) {
      flush()
      return { tokens, end: index }
    } else {
      plain += char
      index++
    }
  }
  flush()
  return stopAtBracket ? { tokens, end: undefined } : tokens
}

const renderTokens = tokens => tokens.map(token => {
  if (token.kind === 'code') return `<code>${escapeHtml(token.value)}</code>`
  if (token.kind === 'br') return '<br>'
  if (token.kind === 'link') {
    const label = renderTokens(token.children)
    return SAFE_HREF.test(token.href) ? `<a href="${escapeHtml(token.href)}">${label}</a>` : label
  }
  return escapeText(markdownInlineText(token.value))
}).join('')

/** Minimal, escaped HTML for one cell: code spans, links, and <br> survive; emphasis is dropped; other markup is text. */
export function markdownCellHtml(text) {
  return renderTokens(inlineTokens(String(text)))
}

/** Render one table from markdownPipeTables as HTML so the existing HTML row readers can parse it. */
export function markdownPipeTableToHtml(table, { cellHtml = markdownCellHtml } = {}) {
  const cell = (tag, text, row, column) => `<${tag}>${cellHtml(text, { row, column, header: tag === 'th' })}</${tag}>`
  const head = `<thead><tr>${table.header.map((text, column) => cell('th', text, -1, column)).join('')}</tr></thead>`
  const body = table.rows.map((row, index) => `<tr>${row.map((text, column) => cell('td', text, index, column)).join('')}</tr>`).join('')
  return `<table>${head}<tbody>${body}</tbody></table>`
}
