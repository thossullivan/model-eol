// Strict Markdown line preparation, GFM pipe tables, and block helpers for provider documentation pages.

export const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const MARKDOWN_ESCAPABLE = /[!-/:-@[-`{-~]/

const QUOTE_MARKER = /^ {0,3}> ?/
const FENCE = /^(`{3,}|~{3,})(.*)$/

function indentWidth(text) {
  let width = 0
  for (const char of text) {
    if (char === ' ') width++
    else if (char === '\t') width += 4 - (width % 4)
    else break
  }
  return width
}

function unquoteLine(line, limit = Infinity) {
  let depth = 0
  let rest = line
  for (let match; depth < limit && (match = rest.match(QUOTE_MARKER));) {
    depth++
    rest = rest.slice(match[0].length)
  }
  return { depth, rest }
}

/** Blank every line of each fenced code block, fences included, so line numbers survive; throws where indentation makes a fence ambiguous. */
export function stripFencedCodeBlocks(markdown) {
  let fence
  return markdown.split(/\r?\n/).map((line, index) => {
    const fail = message => {
      throw new Error(`line ${index + 1}: ${message}`)
    }
    const { depth, rest } = unquoteLine(line)
    if (fence && depth >= fence.depth) {
      const inner = unquoteLine(line, fence.depth).rest
      const indent = indentWidth(inner)
      const closing = inner.trim().match(/^(`{3,}|~{3,})$/)
      if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length && indent < fence.indent + 4) {
        if (indent !== fence.indent && (indent < fence.indent || indent > 3)) fail('closing code fence indentation is ambiguous')
        fence = undefined
      } else if (fence.indent && inner.trim() && indent < fence.indent) {
        fail('code fence content is indented less than its opening fence')
      }
      return ''
    }
    fence = undefined
    const opening = rest.trimStart().match(FENCE)
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) return line
    const indent = indentWidth(rest)
    if (indent >= 4) fail('code fence indented 4 or more spaces')
    fence = { marker: opening[1], indent, depth }
    return ''
  }).join('\n')
}

const isUnicodeSpace = char => char === undefined || /\s/u.test(char)
const isUnicodePunctuation = char => char !== undefined && /[\p{P}\p{S}]/u.test(char)

function delimiterRuns(tokens, source) {
  const runs = []
  for (const token of tokens) {
    if (token.kind !== 'text') continue
    token.removed = new Set()
    for (let index = 0; index < token.value.length;) {
      const char = token.value[index]
      if (char === '\\' && MARKDOWN_ESCAPABLE.test(token.value[index + 1] ?? '')) {
        index += 2
        continue
      }
      if (!'*_~'.includes(char)) {
        index++
        continue
      }
      let end = index
      while (token.value[end] === char) end++
      const before = source[token.start + index - 1]
      const after = source[token.start + end]
      const left = !isUnicodeSpace(after) && (!isUnicodePunctuation(after) || isUnicodeSpace(before) || isUnicodePunctuation(before))
      const right = !isUnicodeSpace(before) && (!isUnicodePunctuation(before) || isUnicodeSpace(after) || isUnicodePunctuation(after))
      const open = char === '_' ? left && (!right || isUnicodePunctuation(before)) : left
      const close = char === '_' ? right && (!left || isUnicodePunctuation(after)) : right
      runs.push({ token, offset: index, length: end - index, char, open, close, remaining: end - index, fromStart: 0, fromEnd: 0, active: true })
      index = end
    }
  }
  return runs
}

// CommonMark emphasis matching; unmatched delimiters stay literal, and GFM strikethrough is refused.
function resolveInlineDelimiters(tokens, source) {
  for (const token of tokens) if (token.kind === 'link') resolveInlineDelimiters(token.children, source)
  const runs = delimiterRuns(tokens, source)
  const tildeOpeners = []
  for (const run of runs) {
    if (run.char !== '~' || run.length > 2) continue
    if (run.close && tildeOpeners.some(opener => opener.length === run.length)) {
      throw new Error(`struck-through text in Markdown is refused: ${source.trim()}`)
    }
    if (run.open) tildeOpeners.push(run)
  }
  const emphasis = runs.filter(run => run.char !== '~')
  for (const [closerIndex, closer] of emphasis.entries()) {
    if (!closer.close) continue
    while (closer.active && closer.remaining) {
      let openerIndex = closerIndex - 1
      for (; openerIndex >= 0; openerIndex--) {
        const opener = emphasis[openerIndex]
        if (!opener.active || !opener.open || !opener.remaining || opener.char !== closer.char) continue
        const sum = opener.length + closer.length
        if ((opener.close || closer.open) && sum % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0)) continue
        break
      }
      if (openerIndex < 0) break
      const opener = emphasis[openerIndex]
      const use = opener.remaining >= 2 && closer.remaining >= 2 ? 2 : 1
      opener.remaining -= use
      opener.fromEnd += use
      closer.remaining -= use
      closer.fromStart += use
      for (let between = openerIndex + 1; between < closerIndex; between++) emphasis[between].active = false
      if (!opener.remaining) opener.active = false
    }
  }
  for (const run of emphasis) {
    for (let offset = 0; offset < run.fromStart; offset++) run.token.removed.add(run.offset + offset)
    for (let offset = 0; offset < run.fromEnd; offset++) run.token.removed.add(run.offset + run.length - 1 - offset)
  }
}

// A backslash before a line end is a hard line break, read as whitespace.
function inlineTextValue(token) {
  let output = ''
  for (let index = 0; index < token.value.length; index++) {
    if (token.removed?.has(index)) continue
    const char = token.value[index]
    const next = token.value[index + 1]
    if (char === '\\' && next !== undefined && MARKDOWN_ESCAPABLE.test(next)) output += token.value[++index]
    else if (char === '\\' && (next === undefined || next === '\n')) output += ' '
    else output += char
  }
  return output
}

/** Plain text of inline Markdown: matched emphasis and backslash escapes are dropped; unmatched delimiters stay literal; strikethrough throws. */
export function markdownInlineText(text) {
  const token = { kind: 'text', value: String(text), start: 0 }
  resolveInlineDelimiters([token], token.value)
  return inlineTextValue(token)
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

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length

// Comment markers inside a code span are text, but stripping comments first would read them as markup.
function assertCommentMarkersOutsideCodeSpans(text) {
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\') {
      index += 2
      continue
    }
    if (text[index] !== '`') {
      index++
      continue
    }
    let run = index
    while (text[run] === '`') run++
    const blank = text.slice(run).search(/\n[ \t]*\n/)
    const block = blank < 0 ? text : text.slice(0, run + blank)
    const end = codeSpanEnd(block, run, run - index)
    if (end < 0) {
      index = run
      continue
    }
    const marker = text.slice(run, end).search(/<!--|--!?>/)
    if (marker >= 0) throw new Error(`line ${lineOf(text, run + marker)}: HTML comment marker inside a code span`)
    index = end
  }
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

/** Index of the first line with a raw HTML heading tag, or -1. */
export const htmlHeadingLineIndex = lines => lines.findIndex(line => /<h[1-6](?:[\s/>]|$)/i.test(line))

/** True for a list item, at any nesting, whose content is an ATX heading. */
export function isListItemHeading(line) {
  let rest = line
  for (let marker; (marker = rest.match(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/));) {
    rest = rest.slice(marker[0].length)
    if (markdownHeading(rest)) return true
  }
  return false
}

/** Source lines with BOM, CRLF, front matter, fenced code, and comments blanked so line numbers survive; quote markers stripped unless unquote is false. */
export function markdownLines(markdown, { unquote = true } = {}) {
  const unfenced = stripFencedCodeBlocks(stripFrontMatter(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')))
  assertCommentMarkersOutsideCodeSpans(unfenced)
  const source = stripCommentsKeepingLines(unfenced)
  const unclosed = source.indexOf('<!--')
  if (unclosed >= 0) throw new Error(`line ${lineOf(source, unclosed)}: unbalanced comment marker: an unclosed HTML comment hides the rest of the page`)
  const hidden = source.search(/<[A-Za-z][^<>]*?(?:\shidden(?=[\s/>=])|\sstyle\s*=\s*["'][^"']*display\s*:\s*none)/i)
  if (hidden >= 0) throw new Error(`line ${lineOf(source, hidden)}: HTML element hidden from the rendered page`)
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
      if (indentWidth(line) >= 4) throw new Error(`line ${number}: table indented 4 or more spaces renders as code or inside a list item`)
      const delimiter = splitPipeRow(lines[index + 1])
      if (delimiter.length !== header.length) {
        throw new Error(`line ${number + 1}: table delimiter row has ${delimiter.length} cells; the header has ${header.length}`)
      }
      const rows = []
      for (index += 2; index < lines.length; index++) {
        const row = lines[index]
        if (!row.trim()) break
        if (BLOCK_START.test(row)) {
          if (splitPipeRow(row)) throw new Error(`line ${index + 1}: table row starts with block or HTML markup`)
          break
        }
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

const RAW_TAG_ATTRIBUTE = String.raw`\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`
const RAW_TAG = new RegExp(String.raw`^(?:<([A-Za-z][A-Za-z0-9-]*)((?:${RAW_TAG_ATTRIBUTE})*)\s*\/?>|<\/([A-Za-z][A-Za-z0-9-]*)\s*>)`)
const PHRASING_TAGS = new Set(['abbr', 'b', 'bdi', 'cite', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark', 'samp', 'small', 'span', 'strong', 'time', 'u', 'var'])
const STRIKE_TAGS = new Set(['del', 's', 'strike'])

function inlineTokens(source, from = 0, stopAtBracket = false) {
  const tokens = []
  let plain = ''
  let plainStart = from
  const flush = () => {
    if (plain) tokens.push({ kind: 'text', value: plain, start: plainStart })
    plain = ''
  }
  const add = (text, at) => {
    if (!plain) plainStart = at
    plain += text
  }
  let index = from
  while (index < source.length) {
    const char = source[index]
    const tag = char === '<' ? source.slice(index).match(RAW_TAG) : null
    if (char === '\\' && MARKDOWN_ESCAPABLE.test(source[index + 1] ?? '')) {
      add(source.slice(index, index + 2), index)
      index += 2
    } else if (char === '`') {
      let run = index
      while (source[run] === '`') run++
      const end = codeSpanEnd(source, run, run - index)
      if (end < 0) {
        add(source.slice(index, run), index)
        index = run
        continue
      }
      flush()
      let code = source.slice(run, end - (run - index))
      if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1)
      tokens.push({ kind: 'code', value: code })
      index = end
    } else if (/^<br\s*\/?>/i.test(source.slice(index))) {
      flush()
      tokens.push({ kind: 'br' })
      index += source.slice(index).match(/^<br\s*\/?>/i)[0].length
    } else if (tag) {
      const name = (tag[1] ?? tag[3]).toLowerCase()
      if (STRIKE_TAGS.has(name)) throw new Error(`struck-through text in Markdown is refused: ${source.trim()}`)
      flush()
      tokens.push(PHRASING_TAGS.has(name) && !tag[2] ? { kind: 'tag', name, closing: Boolean(tag[3]) } : { kind: 'literal', value: tag[0] })
      index += tag[0].length
    } else if (char === '[') {
      const inner = inlineTokens(source, index + 1, true)
      const target = inner.end === undefined ? null : source.slice(inner.end + 1).match(/^\(([^()\s]*)\)/)
      if (!target) {
        add(char, index)
        index++
        continue
      }
      flush()
      tokens.push({ kind: 'link', href: target[1], children: inner.tokens })
      index = inner.end + 1 + target[0].length
    } else if (char === ']' && stopAtBracket) {
      flush()
      return { tokens, end: index }
    } else {
      add(char, index)
      index++
    }
  }
  flush()
  return stopAtBracket ? { tokens, end: undefined } : tokens
}

const renderTokens = tokens => tokens.map(token => {
  if (token.kind === 'code') return `<code>${escapeHtml(token.value)}</code>`
  if (token.kind === 'br') return '<br>'
  if (token.kind === 'tag') return `<${token.closing ? '/' : ''}${token.name}>`
  if (token.kind === 'literal') return escapeText(token.value)
  if (token.kind === 'link') {
    const label = renderTokens(token.children)
    return SAFE_HREF.test(token.href) ? `<a href="${escapeHtml(token.href)}">${label}</a>` : label
  }
  return escapeText(inlineTextValue(token))
}).join('')

/** Minimal, escaped HTML for one cell or paragraph: code spans, links, <br>, and bare phrasing tags survive; matched emphasis is dropped; strikethrough throws; other markup is text. */
export function markdownCellHtml(text) {
  const source = String(text)
  const tokens = inlineTokens(source)
  resolveInlineDelimiters(tokens, source)
  return renderTokens(tokens)
}

/** Render one table from markdownPipeTables as HTML so the existing HTML row readers can parse it. */
export function markdownPipeTableToHtml(table, { cellHtml = markdownCellHtml } = {}) {
  const cell = (tag, text, row, column) => {
    if (/(?:^|[^\\])(?:\\\\)*\\$/.test(text)) throw new Error(`line ${table.line + (row < 0 ? 0 : row + 2)}: table cell ends with a backslash: ${text}`)
    return `<${tag}>${cellHtml(text, { row, column, header: tag === 'th' })}</${tag}>`
  }
  const head = `<thead><tr>${table.header.map((text, column) => cell('th', text, -1, column)).join('')}</tr></thead>`
  const body = table.rows.map((row, index) => `<tr>${row.map((text, column) => cell('td', text, index, column)).join('')}</tr>`).join('')
  return `<table>${head}<tbody>${body}</tbody></table>`
}
