import fs from 'node:fs'
import path from 'node:path'
import {
  azureModelsApiConflictSummary,
  azureModelsApiCredentials,
  azureModelsApiOneDaySummary,
  azureModelsApiSummary,
  fetchAzureModelsApi,
  isAzureModelsApiOneDay,
  reconcileAzureModelsApi,
  redactAzureModelsApiMessage,
} from './azure-models-api.mjs'
import { fetchBoundedBody as fetchBody } from './fetch.mjs'
import {
  headingHtml,
  htmlTableLineIndex,
  isHtmlBody,
  isSetextUnderline,
  MARKDOWN_THEMATIC_BREAK,
  markdownCellHtml,
  markdownHeading,
  markdownPage,
  markdownPipeTables,
  markdownPipeTableToHtml,
  stripCommentsKeepingLines,
  stripFencedCodeBlocks,
} from './markdown.mjs'

import { assertIsoDate, dateCandidates, dateFromText, MODEL_ID_PATTERN, rowLifecycleLabel, sectionProse, stripComments } from './providers.mjs'

export { MAX_SOURCE_BODY_BYTES as MAX_DISTRIBUTOR_BODY_BYTES } from './fetch.mjs'

export const BEDROCK_LIFECYCLE_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html'
export const BEDROCK_LIFECYCLE_MARKDOWN_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.md'
export const BEDROCK_MODEL_CARDS_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html'
export const BEDROCK_MODEL_CARDS_MARKDOWN_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.md'
export const MAX_BEDROCK_MODEL_CARDS = 400
export const VERTEX_MODEL_VERSIONS_URL = 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions'
export const VERTEX_LIFECYCLE_URL = VERTEX_MODEL_VERSIONS_URL
export const VERTEX_MODEL_VERSIONS_MARKDOWN_URL = `${VERTEX_MODEL_VERSIONS_URL}.md.txt`
export const AZURE_MODEL_RETIREMENT_SCHEDULE_URL = 'https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule'
export const AZURE_PUBLISHER_BY_SECTION = new Map([
  ['Azure OpenAI', 'openai'],
  ['Anthropic', 'anthropic'],
  ['Mistral AI', 'mistral'],
  ['Cohere', 'cohere'],
])

export const DISTRIBUTORS = {
  'aws-bedrock': {
    name: 'aws-bedrock',
    sourceUrl: BEDROCK_LIFECYCLE_URL,
    sourceFetchUrl: BEDROCK_LIFECYCLE_MARKDOWN_URL,
    fixture: 'bedrock-lifecycle.md',
    indexUrl: BEDROCK_MODEL_CARDS_URL,
    indexFetchUrl: BEDROCK_MODEL_CARDS_MARKDOWN_URL,
    indexFixture: 'bedrock-model-cards.md',
    cardFixtureDir: 'bedrock-model-cards',
  },
  'vertex-ai': {
    name: 'vertex-ai',
    sourceUrl: VERTEX_MODEL_VERSIONS_URL,
    sourceFetchUrl: VERTEX_MODEL_VERSIONS_MARKDOWN_URL,
    fixture: 'vertex-model-versions.md',
  },
  'azure-ai-foundry': {
    name: 'azure-ai-foundry',
    sourceUrl: AZURE_MODEL_RETIREMENT_SCHEDULE_URL,
    sourceHeaders: { Accept: 'text/markdown' },
    fixture: 'azure-model-retirement-schedule.md',
  },
}

function decodeEntities(text) {
  const named = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['nbsp', ' '], ['ndash', '-'], ['mdash', '-'], ['minus', '-'],
  ])
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name) => named.get(name.toLowerCase()) ?? match)
}

function plainText(fragment) {
  return decodeEntities(stripComments(fragment)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[‐‑‒–\u2014−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function tableRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => {
    const cells = [...row[1].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
    return {
      cells: cells.map(cell => ({
        kind: cell[1].toLowerCase(),
        attrs: cell[2],
        html: cell[3],
        text: plainText(cell[3]),
      })),
    }
  })
}

function span(cell, name) {
  const match = cell.attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'))
  const value = match ? Number(match[1]) : 1
  if (value > 64) throw new Error(`table ${name} exceeds 64: ${match[1]}`)
  return Number.isInteger(value) && value > 0 ? value : 1
}

// Bound logical cells, including carried rowspans, before allocation.
function expandRows(rows) {
  const active = []
  let expandedCells = 0
  const countCell = () => {
    if (++expandedCells > 10000) throw new Error('table exceeds 10000 expanded cells')
  }
  return rows.map(row => {
    const cells = []
    let column = 0
    let source = 0

    const fillActive = () => {
      while (active[column]?.remaining > 0) {
        const slot = active[column]
        countCell()
        cells[column] = slot.cell
        slot.remaining--
        if (slot.remaining === 0) active[column] = undefined
        column++
      }
    }

    while (source < row.cells.length) {
      fillActive()
      const cell = row.cells[source++]
      const columns = span(cell, 'colspan')
      const rowsRemaining = span(cell, 'rowspan') - 1
      for (let offset = 0; offset < columns; offset++) {
        countCell()
        cells[column] = cell
        if (rowsRemaining > 0) active[column] = { cell, remaining: rowsRemaining }
        column++
      }
    }
    fillActive()
    return { ...row, cells }
  })
}

function missingDate(text) {
  return !text || /^(?:-+|n\/?a|none|not\s+(?:available|applicable)|no\s+(?:shutdown|retirement)\s+date\s+announced)$/i.test(text)
}

// The whole value must be one day-precision date, so a qualifier, a second date, or a struck date stops the run.
function lifecycleDate(cell, field, bedrockId, allowAnnouncement = false) {
  if (!cell || missingDate(cell.text) || (allowAnnouncement && /^to be announced$/i.test(cell.text.trim()))) return undefined
  const parsed = BEDROCK_CARD_DAY.test(cell.text.trim()) ? dateFromText(cell.text) : undefined
  if (!parsed) throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has an unrecognised ${field} date: ${cell.text}`)
  return parsed
}

function bedrockLifecycleStatus(cell, bedrockId) {
  const value = cell?.text.trim().toLowerCase().replace(/[‐‑‒–\u2014−]/g, '-').replace(/\s+/g, ' ')
  const statuses = new Map([
    ['active', 'active'],
    ['legacy', 'legacy'],
    ['extended access', 'extended-access'],
    ['public extended access', 'extended-access'],
    ['end-of-life', 'retired'],
    ['end of life', 'retired'],
    ['end-of-life (eol)', 'retired'],
    ['end of life (eol)', 'retired'],
    ['eol', 'retired'],
    ['retired', 'retired'],
  ])
  const status = statuses.get(value)
  if (!status) throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has an unsupported lifecycle status: ${cell?.text || '(empty)'}`)
  return status
}

function vertexHeaderIndexes(rows) {
  for (const [row, candidate] of rows.entries()) {
    const labels = candidate.cells.map(cell => cell.text.toLowerCase())
    const model = labels.findIndex(label => /\bmodel\s+(?:id|identifier)\b/i.test(label))
    const retirement = labels.findIndex(label => /\b(?:retirement|discontinuation)\b.*\bdate\b|\bdate\b.*\b(?:retirement|discontinuation)\b/i.test(label))
    if (model >= 0 && retirement >= 0) return { row, model, eol: retirement }
  }
  return undefined
}

const bedrockRecordRegions = new WeakMap()

function mergeRegionalBedrockRecord(left, right) {
  const leftRegions = bedrockRecordRegions.get(left)
  const rightRegions = bedrockRecordRegions.get(right)
  const withRegions = record => {
    if (leftRegions && rightRegions) bedrockRecordRegions.set(record, [...new Set([...leftRegions, ...rightRegions])])
    return record
  }
  if (left.legacy !== right.legacy || left.eol !== right.eol) {
    if (!leftRegions || !rightRegions || !left.eol || !right.eol || leftRegions.some(region => rightRegions.includes(region))) return undefined
    const statuses = new Set([left.status, right.status])
    if ([...statuses].some(status => status !== 'legacy' && status !== 'extended-access')) return undefined
    // Disjoint region groups: take each field's earliest value and the furthest phase so no region is warned late.
    const merged = { bedrockId: left.bedrockId, status: statuses.has('extended-access') ? 'extended-access' : 'legacy' }
    const legacy = [left.legacy, right.legacy].filter(Boolean).sort()[0]
    if (legacy !== undefined) merged.legacy = legacy
    merged.eol = [left.eol, right.eol].sort()[0]
    return withRegions(merged)
  }
  if (left.status === right.status) return withRegions({ ...left })
  const statuses = new Set([left.status, right.status])
  if (statuses.size === 2 && statuses.has('legacy') && statuses.has('extended-access')) {
    return withRegions({ ...left, status: 'extended-access' })
  }
  return undefined
}

const isBedrockModelId = value => /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9._:+-]*$/i.test(value)

function bedrockEndpointIds(text) {
  const parts = text.split(',').map(part => part.trim().match(/^(\S+) \((bedrock-runtime|bedrock-mantle)\)$/))
  if (parts.length < 2 || parts.some(part => !part || !isBedrockModelId(part[1]))) return undefined
  if (new Set(parts.map(part => part[2])).size !== parts.length) return undefined
  return [...new Set(parts.map(part => part[1]))]
}

const markdownText = text => plainText(markdownCellHtml(text))
const MARKDOWN_INLINE_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/gi

function bedrockMarkdownSource(markdown, what) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error(`${what} is empty`)
  if (isHtmlBody(markdown)) throw new Error(`${what} is HTML, not Markdown`)
  const source = stripCommentsKeepingLines(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
  if (/<!--|--!?>/.test(source)) throw new Error(`${what} has an unbalanced comment marker`)
  return source
}

function bedrockPipeTables(source, what) {
  try {
    return markdownPipeTables(source)
  } catch (error) {
    throw new Error(`${what}: ${error.message}`)
  }
}

const BEDROCK_LIFECYCLE_FIELDS = new Map([
  ['Model name', 'name'],
  ['Model ID', 'model'],
  ['Regions', 'regions'],
  ['Legacy date', 'legacy'],
  ['EOL date', 'eol'],
  ['Public extended access start date', 'extendedAccess'],
])
const BEDROCK_ENTRY_FIELDS = new Set(['name', 'model'])
const BEDROCK_REQUIRED_ROW_FIELDS = [['legacy', 'Legacy date'], ['eol', 'EOL date'], ['extendedAccess', 'Public extended access start date']]
const BEDROCK_STATUS_LABEL = /^(?:(?:model|lifecycle)\s+)*status$/i
const BEDROCK_LABEL_TEXT = new RegExp(`(?:^|[^a-z])(${[...BEDROCK_LIFECYCLE_FIELDS.keys()].map(label => label.replace(/ /g, '\\s+')).join('|')})\\s*:`, 'i')
// Bold, underscore, and HTML emphasis all read as the same label, so emphasis markers and tags are dropped.
const bedrockLooseText = text => markdownText(text.replace(MARKDOWN_INLINE_TAG, ' ')).replace(/[*_`~\\]/g, '')

// A regional line holds several "**Label:** value" segments separated by " / ".
function bedrockLabelledSegments(content, line) {
  const segments = []
  for (const part of content.trim().split(/\s+\/\s+(?=\*\*)/)) {
    const match = part.match(/^\*\*([^*]+?):\*\*(.*)$/)
    if (!match) {
      if (!segments.length) return undefined
      throw new Error(`aws-bedrock lifecycle page line ${line}: unrecognised segment: ${part}`)
    }
    const label = match[1].trim()
    const key = BEDROCK_LIFECYCLE_FIELDS.get(label) ?? (BEDROCK_STATUS_LABEL.test(label) ? 'status' : undefined)
    if (!key) throw new Error(`aws-bedrock lifecycle page line ${line}: unrecognised label: ${label}`)
    const nestedLabel = bedrockLooseText(match[2]).match(BEDROCK_LABEL_TEXT)
    if (nestedLabel) throw new Error(`aws-bedrock lifecycle page line ${line}: the ${label} value holds another label: ${nestedLabel[1]}`)
    segments.push({ label, key, value: markdownText(match[2]) })
  }
  return segments
}

const indentWidth = text => [...text].reduce((width, character) => character === '\t' ? width + 4 - (width % 4) : width + 1, 0)

function bedrockLifecycleEntries(source) {
  const entries = []
  let entry
  for (const [index, line] of source.split('\n').entries()) {
    const number = index + 1
    const top = line.match(/^[-*+]([ \t]+)(.*)$/)
    const nested = line.match(/^([ \t]+)[-*+][ \t]+(.*)$/)
    const segments = nested && bedrockLabelledSegments(nested[2], number)
    if (top) {
      const provider = top[2].trim().match(/^\*\*([^*]+)\*\*$/)
      entry = provider ? { provider: markdownText(provider[1]), line: number, items: [], content: 1 + indentWidth(top[1]) } : undefined
      if (entry) entries.push(entry)
    } else if (segments) {
      if (!entry) throw new Error(`aws-bedrock lifecycle page line ${number}: labelled item outside a model entry: ${line.trim()}`)
      // A field belongs to the entry only one list level down; a deeper item is a note on the item above it.
      const indent = indentWidth(nested[1])
      entry.indent ??= indent
      if (indent !== entry.indent || indent < entry.content || indent >= entry.content + 4) {
        throw new Error(`aws-bedrock lifecycle page line ${number}: labelled item at a different list depth in the ${entry.provider} entry: ${line.trim()}`)
      }
      entry.items.push({ line: number, segments })
    } else if (entry && line.trim()) {
      throw new Error(`aws-bedrock lifecycle page line ${number}: unrecognised line in the ${entry.provider} entry: ${line.trim()}`)
    } else {
      entry = undefined
    }
  }
  return entries
}

// Entry-level fields apply to every regional line; a label may appear once per line it applies to.
function bedrockEntryRows(entry) {
  if (!entry.items.length) throw new Error(`aws-bedrock lifecycle page line ${entry.line}: the ${entry.provider} entry has no labelled fields`)
  const fields = new Map()
  const regional = []
  for (const item of entry.items) {
    const target = item.segments.length > 1 ? new Map() : fields
    for (const segment of item.segments) {
      if (target !== fields && BEDROCK_ENTRY_FIELDS.has(segment.key)) {
        throw new Error(`aws-bedrock lifecycle page line ${item.line}: ${segment.label} inside a regional line`)
      }
      if (target.has(segment.key)) throw new Error(`aws-bedrock lifecycle page line ${item.line}: duplicate ${segment.label}`)
      target.set(segment.key, segment)
    }
    if (target !== fields) regional.push({ line: item.line, fields: target })
  }
  for (const row of regional) {
    const shared = [...row.fields.values()].find(segment => fields.has(segment.key))
    if (shared) throw new Error(`aws-bedrock lifecycle page line ${row.line}: duplicate ${shared.label}`)
  }
  return { fields, rows: regional.length ? regional.map(row => new Map([...fields, ...row.fields])) : [fields] }
}

/** Parse the Markdown copy of AWS Bedrock's legacy lifecycle page: one labelled list per model under a bold provider item. */
export function parseBedrockLifecycleMarkdown(markdown) {
  let source = bedrockMarkdownSource(markdown, 'aws-bedrock lifecycle page')
  for (const table of bedrockPipeTables(source, 'aws-bedrock lifecycle page')) {
    if (table.header.some(cell => /\bmodel\s+(?:id|identifier)\b|\blegacy\b|\beol\b/i.test(markdownText(cell)))) {
      throw new Error(`aws-bedrock lifecycle page line ${table.line}: lifecycle table where labelled lists are expected`)
    }
  }
  source = stripFencedCodeBlocks(source)
  if (/<table\b/i.test(source)) throw new Error('aws-bedrock lifecycle page has a raw HTML table, which the Markdown reader does not parse')
  const entries = bedrockLifecycleEntries(source)
  if (!entries.length) throw new Error('aws-bedrock lifecycle page has no model entries')

  const consumed = new Map()
  const records = []
  for (const entry of entries) {
    for (const segment of entry.items.flatMap(item => item.segments)) consumed.set(segment.label, (consumed.get(segment.label) ?? 0) + 1)
    const { fields, rows } = bedrockEntryRows(entry)
    const model = fields.get('model')
    if (!model) throw new Error(`aws-bedrock lifecycle page line ${entry.line}: the ${entry.provider} entry has no Model ID`)
    const ids = isBedrockModelId(model.value) ? [model.value] : bedrockEndpointIds(model.value)
    if (!ids) throw new Error(`aws-bedrock lifecycle page has an invalid model id: ${model.value || '(empty)'}`)
    const bedrockId = ids.join(', ')
    for (const row of rows) {
      const missing = BEDROCK_REQUIRED_ROW_FIELDS.find(([key]) => !row.has(key))
      if (missing) throw new Error(`aws-bedrock lifecycle entry ${bedrockId} is missing its ${missing[1]}`)
      const cell = key => row.has(key) ? { text: row.get(key).value } : undefined
      const legacy = lifecycleDate(cell('legacy'), 'legacy', bedrockId)
      const eol = lifecycleDate(cell('eol'), 'EOL', bedrockId)
      const extendedAccess = lifecycleDate(cell('extendedAccess'), 'public extended access', bedrockId, true)
      if (legacy && eol && eol < legacy) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has EOL before legacy date`)
      }
      if (extendedAccess && legacy && extendedAccess < legacy) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has public extended access before legacy date`)
      }
      if (extendedAccess && eol && extendedAccess > eol) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has public extended access after EOL date`)
      }
      // The page schedules Extended Access, so preserve that signal without comparing against the runner clock.
      const status = row.has('status')
        ? bedrockLifecycleStatus(cell('status'), bedrockId)
        : extendedAccess
          ? 'extended-access'
          : 'legacy'
      if (status === 'extended-access' && !extendedAccess) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} reports extended access without a start date`)
      }
      const regionCodes = cell('regions')?.text.split(',').map(region => region.trim()).filter(Boolean)
      const regions = regionCodes?.every(region => /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region)) ? regionCodes : undefined
      for (const id of ids) {
        const record = { bedrockId: id, status }
        if (legacy !== undefined) record.legacy = legacy
        if (eol !== undefined) record.eol = eol
        if (regions?.length) bedrockRecordRegions.set(record, regions)
        records.push(record)
      }
    }
  }

  for (const label of BEDROCK_LIFECYCLE_FIELDS.keys()) {
    const count = [...source.matchAll(new RegExp(`\\*\\*\\s*${label}\\s*(?::\\s*\\*\\*|\\*\\*\\s*:)`, 'gi'))].length
    if (count !== (consumed.get(label) ?? 0)) throw new Error(`aws-bedrock lifecycle page has the label ${label} outside a model entry`)
  }
  const entryLines = new Set(entries.flatMap(entry => entry.items.map(item => item.line)))
  for (const [index, line] of source.split('\n').entries()) {
    const label = !entryLines.has(index + 1) && bedrockLooseText(line).match(BEDROCK_LABEL_TEXT)
    if (label) throw new Error(`aws-bedrock lifecycle page line ${index + 1}: the label ${label[1]} outside a model entry`)
  }

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.bedrockId)
    if (!previous) {
      unique.set(record.bedrockId, record)
    } else {
      const merged = mergeRegionalBedrockRecord(previous, record)
      if (!merged) throw new Error(`aws-bedrock lifecycle page has conflicting rows for ${record.bedrockId}`)
      unique.set(record.bedrockId, merged)
    }
  }
  return [...unique.values()]
}

/** The Markdown copy of a Bedrock user guide page sits next to the human page. */
export const bedrockMarkdownUrl = url => url.replace(/\.html$/, '.md')

/** Card links from the Markdown index, as the human card URLs that records cite. */
export function parseBedrockModelCardsIndexMarkdown(markdown) {
  const where = `aws-bedrock index ${BEDROCK_MODEL_CARDS_URL}`
  const source = stripFencedCodeBlocks(bedrockMarkdownSource(markdown, where))
  const targets = [
    ...[...source.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+[^)]*)?\)/g)].map(match => match[1]),
    ...[...source.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map(match => match[1]),
    ...[...source.matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)].map(match => match[1] ?? match[2] ?? match[3]),
  ]
  const urls = new Set()
  const directory = new URL('.', BEDROCK_MODEL_CARDS_URL).href
  for (const href of targets) {
    if (!href) continue
    const decoded = decodeEntities(href).replace(/\\([!-/:-@[-`{-~])/g, '$1')
    let url
    try {
      url = new URL(decoded, BEDROCK_MODEL_CARDS_URL)
    } catch {
      if (/model-card-/i.test(decoded.split(/[?#]/)[0])) throw new Error(`${where} has invalid model card href: ${href}`)
      continue
    }
    url.search = ''
    url.hash = ''
    if (!/model-card-/i.test(url.pathname)) continue
    const slug = path.posix.basename(url.pathname).match(/^(model-card-[a-z0-9_.-]+)\.(?:md|html)$/i)
    if (url.protocol !== 'https:' || new URL('.', url).href !== directory || !slug) throw new Error(`${where} has invalid model card href: ${href}`)
    urls.add(new URL(`${slug[1]}.html`, directory).href)
    if (urls.size > MAX_BEDROCK_MODEL_CARDS) throw new Error(`${where} exceeds ${MAX_BEDROCK_MODEL_CARDS} model cards`)
  }
  if (!urls.size) throw new Error(`${where} has no model card links`)
  return [...urls]
}

const BEDROCK_CARD_LABELS = ['Model launch date', 'EOL no sooner than', 'Legacy period', 'Model lifecycle policy', 'Model EOL date', 'Model lifecycle']
// Policy link text and the EOL banner's "see Model lifecycle" repeat the words, so only the colon form counts.
const BEDROCK_CARD_LABEL_COUNT = new Map([['Model lifecycle', /\bModel lifecycle\s*:/gi]])
const BEDROCK_CARD_LIFECYCLE = /^(?:Active|(Legacy)|EOL: (\d{4}-\d{2}-\d{2}))(?: \(certain regions\))?$/
// The feed has no Region dimension, so a card that is Legacy in any Region is legacy.
const BEDROCK_CARD_REGIONS = '[a-z]{2}(?:-gov)?-[a-z]+-\\d(?:, [a-z]{2}(?:-gov)?-[a-z]+-\\d)*'
const BEDROCK_CARD_REGIONAL_LIFECYCLE = new RegExp(`^Legacy in (${BEDROCK_CARD_REGIONS}); Active in other Regions$`)
const BEDROCK_CARD_REGIONAL_EOL = new RegExp(`^(.+) \\((${BEDROCK_CARD_REGIONS}) only\\)$`)
function bedrockCardRegionSet(list) {
  const regions = list.split(', ')
  if (new Set(regions).size !== regions.length) throw new Error(`duplicate Region in ${list}`)
  return regions.sort().join(', ')
}
const BEDROCK_CARD_MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const BEDROCK_CARD_DAY = new RegExp(`^${BEDROCK_CARD_MONTH} \\d{1,2}, (?:19|20)\\d{2}$`, 'i')
const BEDROCK_CARD_MONTH_ONLY = new RegExp(`^${BEDROCK_CARD_MONTH} (?:19|20)\\d{2}$`, 'i')
const BEDROCK_CARD_NO_EOL = /^(?:N\/A|Not announced\.?)$/
const BEDROCK_CARD_ORDINAL_DAY = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (${BEDROCK_CARD_MONTH}) ((?:19|20)\\d{2})$`, 'i')

// Inline HTML tags are transparent to field text, as they are on the HTML page.
const bedrockCardText = text => markdownText(text.replace(MARKDOWN_INLINE_TAG, ' '))

function bedrockCardFields(lines, pageText) {
  const fields = new Map()
  for (const line of lines) {
    const content = line.replace(/^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '').trim()
    if (!content) continue
    const text = bedrockCardText(content)
    const label = BEDROCK_CARD_LABELS.find(candidate => text.startsWith(`${candidate}:`))
    if (!label) {
      const bold = content.match(/^(\*\*|__)(.+?)\1/) ?? content.match(/^\s*<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/i)
      const boldText = bold && bedrockCardText(bold[2])
      const renamedLabel = boldText && /^Model lifecycle\b/i.test(boldText) && !/^Model lifecycle polic/i.test(boldText)
      if (renamedLabel || /^Model lifecycle\W*(?:Active|Legacy|EOL)\b/i.test(text) || /^Model lifecycle\b(?!\s+polic)[^:.]{0,30}:/i.test(text)) throw new Error(`unrecognised Model lifecycle field: ${text}`)
      continue
    }
    if (fields.has(label)) throw new Error(`duplicate ${label} field`)
    const value = text.slice(label.length + 1).trim()
    if (!value) throw new Error(`empty ${label} field`)
    fields.set(label, value)
  }
  for (const label of BEDROCK_CARD_LABELS) {
    const count = [...pageText.matchAll(BEDROCK_CARD_LABEL_COUNT.get(label) ?? new RegExp(`\\b${label}\\b`, 'gi'))].length
    if (count !== Number(fields.has(label))) throw new Error(`unaccounted ${label} field outside its field line`)
  }
  return fields
}

const BEDROCK_LIFECYCLE_WORD = /(?<![a-z0-9_])(?:legacy|eol|e\.o\.l|retired|end[\s-]+of[\s-]+(?:life(?:cycle)?|support))(?![a-z0-9_])/i
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^()\s]*(?:\s+"[^"]*")?\)/g

// Image alt text, raw tags and their attributes, and words split by markup all count as cell text.
function bedrockLifecycleCell(cell) {
  const words = text => text.split(/\s+/).filter(token => token && !(isBedrockModelId(token) && /^[a-z0-9_-]{2,}\./i.test(token)) && !/^https?:\/\//i.test(token)).join(' ')
  const visible = bedrockCardText(cell.replace(MARKDOWN_IMAGE, ' '))
  const texts = [visible, markdownText(cell), markdownText(cell.replace(/<br\s*\/?>/gi, ' ').replace(MARKDOWN_INLINE_TAG, ''))]
  return { visible, lifecycle: texts.some(text => BEDROCK_LIFECYCLE_WORD.test(words(text))) }
}

function bedrockCardDate(value, label, allowMonth = false) {
  if (allowMonth && BEDROCK_CARD_MONTH_ONLY.test(value)) return undefined
  if (!BEDROCK_CARD_DAY.test(value)) throw new Error(`unrecognised ${label} date: ${value}`)
  return dateFromText(value)
}

/** Parse the Markdown copy of one Bedrock model card; records and skips cite source, the human card URL. */
export function parseBedrockModelCardMarkdown(markdown, source) {
  try {
    const page = bedrockMarkdownSource(markdown, 'page')
    const unfenced = stripFencedCodeBlocks(page)
    if (/<table\b/i.test(unfenced)) throw new Error('raw HTML table, which the Markdown reader does not parse')
    const tables = bedrockPipeTables(page, 'page').map(table => [table.header, ...table.rows])
    const idTables = tables.filter(rows => rows[0].some(cell => bedrockCardText(cell) === 'Model ID'))
    if (!idTables.length) throw new Error('no Model ID table')
    if (idTables.length > 1) throw new Error('more than one Model ID table')
    const rows = idTables[0]
    const columns = rows[0].flatMap((cell, index) => bedrockCardText(cell) === 'Model ID' ? [index] : [])
    if (columns.length !== 1) throw new Error('ambiguous Model ID columns')
    if (rows.length < 2) throw new Error('Model ID table has no entries')
    const ids = new Set()
    for (const [offset, row] of rows.slice(1).entries()) {
      const id = bedrockCardText(row[columns[0]] ?? '')
      if (/^n\/a$/i.test(id)) continue
      if (!isBedrockModelId(id)) throw new Error(`invalid Model ID in row ${offset + 2}: ${id || '(empty)'}`)
      ids.add(id)
    }
    const fields = bedrockCardFields(unfenced.split('\n'), page.split('\n').map(bedrockCardText).join(' '))
    const lifecycle = fields.get('Model lifecycle')
    const lifecycleMatch = lifecycle === undefined ? undefined : lifecycle.match(BEDROCK_CARD_LIFECYCLE)
    const regionalMatch = lifecycle?.match(BEDROCK_CARD_REGIONAL_LIFECYCLE)
    if (lifecycle !== undefined && !lifecycleMatch && !regionalMatch) throw new Error(`unrecognised Model lifecycle: ${lifecycle}`)
    const lifecycleRegions = regionalMatch && bedrockCardRegionSet(regionalMatch[1])
    const lifecycleEol = lifecycleMatch?.[2] && assertIsoDate(lifecycleMatch[2], 'Model lifecycle EOL')
    const lifecycleLegacy = Boolean(regionalMatch || lifecycleMatch?.[1] || lifecycleEol)
    const skip = reason => ({ records: [], skipped: [{ source, ids: [...ids], reason }] })
    const regionDates = []
    for (const cell of tables.flat(2)) {
      const { visible, lifecycle: mentionsLifecycle } = bedrockLifecycleCell(cell)
      if (!mentionsLifecycle) continue
      const match = visible.match(/^(?:Legacy \(EOL: (\d{4}-\d{2}-\d{2})\)|EOL: (\d{4}-\d{2}-\d{2}))$/)
      if (!match) throw new Error(`unrecognised region EOL: ${visible}`)
      regionDates.push(assertIsoDate(match[1] ?? match[2], 'region EOL'))
    }
    if (!ids.size) return skip('no model ids')
    const eol = fields.get('Model EOL date')
    if (!BEDROCK_CARD_LABELS.slice(0, 3).some(label => fields.has(label)) && (eol === undefined || BEDROCK_CARD_NO_EOL.test(eol)) && !regionDates.length && !lifecycleEol) return skip('no lifecycle fields')

    const launch = fields.get('Model launch date')
    if (launch !== undefined) bedrockCardDate(launch.replace(BEDROCK_CARD_ORDINAL_DAY, '$2 $1, $3'), 'Model launch date', true)
    const period = fields.get('Legacy period')
    if (period !== undefined && !/^(?:at least )?(?:1 (?:month|day)|(?:[2-9]|[1-9]\d{1,2}) (?:months|days))$/.test(period)) throw new Error(`unrecognised Legacy period: ${period}`)
    const floor = fields.get('EOL no sooner than')
    const candidates = []
    let floorDate
    if (floor !== undefined && !/^(?:n\/a|not applicable)\b/i.test(floor)) {
      floorDate = bedrockCardDate(floor, 'EOL no sooner than', true)
      if (floorDate) candidates.push(floorDate)
    }
    let exact
    let legacyField = false
    if (eol !== undefined && !BEDROCK_CARD_NO_EOL.test(eol)) {
      const us = eol.match(/^No sooner than (\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})$/)
      const legacy = eol.match(/^Legacy: (.+)$/)
      if (us) candidates.push(assertIsoDate(`${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`, 'Model EOL date'))
      else if (legacy) {
        exact = bedrockCardDate(legacy[1], 'Model EOL date')
        legacyField = true
      } else {
        const regional = eol.match(BEDROCK_CARD_REGIONAL_EOL)
        if (regional && bedrockCardRegionSet(regional[2]) !== lifecycleRegions) throw new Error(`Model EOL date ${eol} does not match the Regions in Model lifecycle: ${lifecycle ?? '(absent)'}`)
        exact = bedrockCardDate(regional ? regional[1] : eol, 'Model EOL date')
      }
    }
    if (exact && floorDate && exact < floorDate) throw new Error(`Model EOL date ${exact} precedes EOL no sooner than ${floorDate}`)
    if (regionDates.length && !exact) throw new Error(`region EOL ${regionDates[0]} without an exact Model EOL date`)
    const mismatch = regionDates.find(date => date !== exact)
    if (mismatch) throw new Error(`region EOL ${mismatch} differs from Model EOL date ${exact}`)
    if (lifecycleEol && !exact) throw new Error(`Model lifecycle EOL ${lifecycleEol} without an exact Model EOL date`)
    if (lifecycleEol && lifecycleEol !== exact) throw new Error(`Model lifecycle EOL ${lifecycleEol} differs from Model EOL date ${exact}`)
    if (!exact && !candidates.length) return skip('no day-precision date')
    const payload = exact
      ? { shutdown: exact, status: regionDates.length || legacyField || lifecycleLegacy ? 'legacy' : 'active' }
      : { shutdown: candidates.sort().at(-1), date_precision: 'tentative', status: lifecycleLegacy ? 'legacy' : 'active' }
    return { records: [...ids].map(bedrockId => ({ bedrockId, ...payload, source })), skipped: [] }
  } catch (error) {
    throw new Error(`aws-bedrock model card ${source}: ${error.message}`)
  }
}

function sameLifecycle(left, right) {
  return ['announced', 'shutdown', 'date_precision', 'status'].every(field => left[field] === right[field])
}

export function mergeBedrockSources(legacyRecords, cardRecords) {
  const legacy = new Map(legacyRecords.map(record => [record.bedrockId, { ...record, source: BEDROCK_LIFECYCLE_URL }]))
  const cards = new Map()
  const conflicts = []
  for (const record of cardRecords) {
    const table = legacy.get(record.bedrockId)
    if (table) {
      if (table.eol && record.shutdown && !record.date_precision && table.eol !== record.shutdown) {
        conflicts.push({ via: 'aws-bedrock', id: record.bedrockId, kept: table, discarded: record })
      }
      continue
    }
    const previous = cards.get(record.bedrockId)
    if (previous && !sameLifecycle(previous, record)) {
      throw new Error(`aws-bedrock cards conflict for ${previous.bedrockId} (${previous.source}) and ${record.bedrockId} (${record.source})`)
    }
    if (!previous) cards.set(record.bedrockId, record)
  }
  return { records: [...legacy.values(), ...cards.values()], conflicts }
}

export function skippedModelCardSummary(card) {
  return `aws-bedrock model card ${card.source}: skipped ${card.ids.join(', ')}; ${card.reason}`
}

function vertexModelId(fragment) {
  const code = [...String(fragment).matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)]
    .map(match => plainText(match[1]))
    .find(Boolean)
  const value = code ?? plainText(fragment)
  const id = value.replace(/\s*\*+$/, '').trim()
  return id && !/\s/.test(id) ? id : undefined
}

function vertexDate(cell, modelId) {
  if (!cell || missingDate(cell.text)) return undefined
  const date = dateFromText(cell.text)
  if (!date) throw new Error(`vertex-ai lifecycle entry ${modelId} has an unrecognised retirement date: ${cell.text}`)
  return date
}

const VERTEX_PRECISION_PATTERN = /earliest\s+possible|retirement\s+timelines?\s+may\s+be\s+extended|not\s+(?:be\s+)?moved\s+to\s+an\s+earlier\s+date|or\s+later|no\s+sooner\s+than/i

const VERTEX_FIXED_DATE_PATTERN = /\bfixed\s+(?:retirement\s+)?dates?\b/i
const VERTEX_NEGATION = /\b(?:no|not|never|without|nor)\b|n't\b/i

function vertexStatesFixedDates(text) {
  for (const match of text.matchAll(new RegExp(VERTEX_FIXED_DATE_PATTERN.source, 'gi'))) {
    if (!VERTEX_NEGATION.test(text.slice(Math.max(0, match.index - 40), match.index))) return true
  }
  return false
}

function blankOutermostTables(html) {
  let out = ''
  let cursor = 0
  let depth = 0
  let start = 0
  for (const tag of html.matchAll(/<(\/?)table\b[^>]*>/gi)) {
    if (!tag[1]) {
      if (!depth++) start = tag.index
    } else if (depth && !--depth) {
      out += html.slice(cursor, start) + ' '.repeat(tag.index + tag[0].length - start)
      cursor = tag.index + tag[0].length
    }
  }
  if (depth) return out + html.slice(cursor, start) + ' '.repeat(html.length - start)
  return out + html.slice(cursor)
}

/** For a table offset, its enclosing sections nearest first with the prose each owns, up to an archive heading or else the page intro. */
function vertexSectionChains(html) {
  const blank = match => ' '.repeat(match.length)
  const outside = blankOutermostTables(String(html).replace(/<!--[\s\S]*?--!?>/g, blank).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, blank))
  const headings = [...outside.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)]
    .map(match => ({ start: match.index, end: match.index + match[0].length, level: Number(match[1]), attrs: match[2], text: plainText(match[3]) }))
  const own = headings.map((heading, index) => plainText(outside.slice(heading.end, headings[index + 1]?.start ?? outside.length)))
  const intro = { heading: '(page intro)', own: plainText(outside.slice(0, headings[0]?.start ?? outside.length)), intro: true }
  const archive = heading => /\bid\s*=\s*["']retired-models["']/i.test(heading.attrs) ||
    /^(?:retired models|the following table lists the retired models\b.*)$/i.test(heading.text)
  return tableStart => {
    const chain = []
    let level = 7
    for (let index = headings.findLastIndex(heading => heading.end <= tableStart); index >= 0; index--) {
      if (headings[index].level >= level) continue
      level = headings[index].level
      chain.push({ heading: headings[index].text, own: own[index] })
      if (archive(headings[index])) return chain
    }
    return [...chain, intro]
  }
}

// The nearest section that speaks about its dates decides: "we post a fixed date" is exact even under an earliest-date parent.
function vertexDatePrecision(chain, text) {
  if (VERTEX_PRECISION_PATTERN.test(text)) return 'earliest'
  for (const section of chain) {
    const qualified = VERTEX_PRECISION_PATTERN.test(section.own)
    if (section.intro) return qualified ? 'earliest' : undefined
    const fixed = vertexStatesFixedDates(section.own)
    if (qualified && fixed) throw new Error(`vertex-ai section "${section.heading}" states both fixed and earliest-possible retirement dates`)
    if (fixed) return undefined
    if (qualified) return 'earliest'
  }
  return undefined
}

/** Parse Vertex model versions and lifecycle tables. */
export function parseVertexModelVersionsHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('vertex-ai lifecycle page is empty')

  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const governingProse = sectionProse(html, VERTEX_PRECISION_PATTERN)
  const sectionChain = vertexSectionChains(html)
  const records = []
  const archived = new WeakSet()
  let recognisedTables = 0
  for (const table of tables) {
    const rows = expandRows(tableRows(table[1]))
    const headers = vertexHeaderIndexes(rows)
    if (!headers) continue
    recognisedTables++
    const section = governingProse(table.index)
    const chain = sectionChain(table.index)
    for (const row of rows.slice(headers.row + 1)) {
      const modelCell = row.cells[headers.model]
      if (!modelCell || !modelCell.text) continue
      const modelId = vertexModelId(modelCell.html)
      if (!modelId) continue
      const retirementCell = row.cells[headers.eol]
      if (!retirementCell) throw new Error(`vertex-ai lifecycle entry ${modelId} is missing retirement date`)
      const shutdown = vertexDate(retirementCell, modelId)
      const record = { vertexId: modelId }
      if (shutdown) {
        record.shutdown = shutdown
        const precision = vertexDatePrecision(chain, retirementCell.text)
        if (precision) record.date_precision = precision
      }
      if (section.archived) archived.add(record)
      records.push(record)
    }
  }

  if (!recognisedTables) throw new Error('vertex-ai lifecycle page has no recognised model table')
  if (!records.length) throw new Error('vertex-ai lifecycle page has no model entries')

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.vertexId)
    if (!previous) {
      unique.set(record.vertexId, record)
      continue
    }
    const sameDate = previous.shutdown === record.shutdown
    if (sameDate && previous.date_precision === record.date_precision) continue
    // An archive row yields to the available row with the same date; only their precision differs.
    if (sameDate && archived.has(previous) !== archived.has(record)) {
      if (archived.has(previous)) unique.set(record.vertexId, record)
      continue
    }
    throw new Error(`vertex-ai lifecycle page has conflicting rows for ${record.vertexId}: ${rowLifecycleLabel(previous)} and ${rowLifecycleLabel(record)}`)
  }
  return [...unique.values()]
}

export const parseVertexLifecycleHtml = parseVertexModelVersionsHtml
export const parseVertexModelLifecycle = parseVertexModelVersionsHtml
export const parseVertexModelVersions = parseVertexModelVersionsHtml

// Google's Markdown generator backslash-escapes punctuation even inside code spans, where CommonMark keeps it literal.
// A raw tag the cell renderer keeps as escaped text (one with attributes, or not a bare phrasing tag) could hide wording such as "no earlier".
function refuseEscapedTags(html, label, source) {
  if (/&lt;\/?[a-z][a-z0-9-]*(?:\s[^]*?)?&gt;/i.test(html.replace(/<code>[\s\S]*?<\/code>/g, ''))) throw new Error(`${label} page has inline HTML the Markdown reader cannot read: ${source.trim()}`)
  return html
}

const vertexCellHtml = text => refuseEscapedTags(markdownCellHtml(text), 'vertex-ai lifecycle', text).replace(/<code>([\s\S]*?)<\/code>/g, (_, code) => `<code>${code.replace(/\\([!-/:-@[-`{-~])/g, '$1')}</code>`)

/** markdownPage of a page that is neither an HTML document nor carries a raw HTML table. */
function markdownPageLines(markdown, label) {
  if (typeof markdown !== 'string') throw new Error(`${label} page must be a string`)
  if (/^\s*<(?:!doctype|html)\b/i.test(markdown.replace(/^\uFEFF/, ''))) throw new Error(`${label} source is HTML, not Markdown`)
  const page = markdownPage(markdown)
  if (htmlTableLineIndex(page.lines) >= 0) throw new Error(`${label} page has a raw HTML table, which the Markdown reader does not parse`)
  return page
}

/** Render the Vertex Markdown copy as the headings, prose, and tables that parseVertexModelVersionsHtml reads. */
export function vertexMarkdownToHtml(markdown) {
  const { tableAt, lines } = markdownPageLines(markdown, 'vertex-ai lifecycle')
  const html = []
  let paragraph = false
  for (let index = 0; index < lines.length; index++) {
    const table = tableAt.get(index)
    const line = lines[index]
    if (table) {
      html.push(markdownPipeTableToHtml(table, { cellHtml: vertexCellHtml }))
      index += table.rows.length + 1
    } else if (paragraph && isSetextUnderline(line)) {
      throw new Error(`vertex-ai lifecycle page line ${index + 1}: setext heading; section headings must use #`)
    } else if (line.trim()) {
      const heading = markdownHeading(line)
      html.push(heading ? headingHtml(heading, vertexCellHtml(heading.text)) : `<p>${vertexCellHtml(line)}</p>`)
      paragraph = !heading
      continue
    }
    paragraph = false
  }
  return html.join('\n')
}

/** Parse the Markdown copy of the Vertex model versions page with the same rules as the HTML page. */
export function parseVertexModelVersionsMarkdown(markdown) {
  return parseVertexModelVersionsHtml(vertexMarkdownToHtml(markdown))
}

const AZURE_LIFECYCLE_STATUSES = new Map([
  ['GA', 'active'],
  ['Preview', 'active'],
  ['Legacy', 'active'],
  ['Deprecated', 'legacy'],
  ['Retired', 'retired'],
])

function azureHeaderIndexes(rows) {
  for (const [row, candidate] of rows.entries()) {
    if (row > 0 && !candidate.cells.some(cell => cell.kind === 'th')) continue
    const labels = candidate.cells.map(cell => cell.text.toLowerCase())
    const fineTuning = ['model', 'version', 'training retirement date', 'deployment retirement date']
    if (labels.length === fineTuning.length && fineTuning.every(label => labels.includes(label))) return undefined
    const lifecycleHeader = labels.some(label => /retirement|lifecycle|replacement/.test(label))
      || ['model', 'model id', 'version', 'status'].filter(label => labels.includes(label)).length >= 2
    if (!lifecycleHeader) continue
    const columns = ['model', 'version', 'lifecycle', 'retirement date', 'replacement']
    if (labels.length !== columns.length || columns.some(label => !labels.includes(label))) {
      throw new Error(`azure-ai-foundry lifecycle table has invalid header row: ${labels.join(' | ')}`)
    }
    return { row, indexes: columns.map(label => labels.indexOf(label)) }
  }
  return undefined
}

function azureIsoDate(value, label) {
  try {
    return assertIsoDate(value, label)
  } catch {
    throw new Error(`azure-ai-foundry lifecycle entry ${label} has an invalid date: ${value || '(empty)'}`)
  }
}

const AZURE_MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`
const AZURE_FOOTNOTE_PRECISION_PATTERN = new RegExp([
  String.raw`\b(?:no|not)\s+(?:earlier|sooner|later)\s+than\b`,
  String.raw`\bearliest\b`,
  String.raw`\b(?:or|and)\s+(?:later|after|earlier|sooner|before|thereafter)\b`,
  String.raw`\bnot\s+before\b`,
  String.raw`\bafter\s+(?:(?:19|20)\d{2}\b|${AZURE_MONTH}\s+\d{1,2}\b)`,
  String.raw`\bat\s+least\b`,
  String.raw`\bat\s+a\s+later\s+date\b`,
  String.raw`\buntil\s+further\s+notice\b`,
  String.raw`\bsubject\s+to\s+change\b`,
  String.raw`\b(?:may|might|could|can|will)\s+(?:be\s+)?(?:shift(?:ed)?|slip|change[ds]?|extended|updated|revised|postponed|delayed|moved)\b`,
  String.raw`\bbegin(?:s|ning)?\b`,
  String.raw`\bstarting\b`,
  String.raw`\broll(?:s|ing)?\s+out\b`,
  String.raw`\bphased\b`,
  String.raw`\btentative`,
  String.raw`\bapproximate`,
  String.raw`\bestimate[ds]?\b`,
  String.raw`\bexpected\s+to\b`,
  String.raw`\b(?:will|to)\s+be\s+(?:announced|determined|confirmed|communicated|decided)\b`,
  String.raw`\btb[acd]\b`,
  String.raw`\bplanned\b`,
  String.raw`\btarget(?:s|ed|ing)?\b`,
  String.raw`\bretires?\s+(?:earlier|sooner|later)\b`,
].join('|'), 'i')
const AZURE_FORMAT_CHARACTERS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
const AZURE_BLOCK_TAG = /<\/?(?:p|div|br|li|ul|ol|tr|td|th|h[1-6]|table|blockquote|section)\b[^>]*>/gi
const AZURE_YEAR = /\b(?:19|20)\d{2}\b/

function azureProseText(fragment, inlineTag) {
  let text = fragment.replace(AZURE_BLOCK_TAG, ' ').replace(/<[^>]*>/g, inlineTag)
  for (let previous; previous !== text;) {
    previous = text
    text = plainText(decodeEntities(text).replace(/[<>]/g, ' ').replace(/&[a-z][a-z0-9]*;/gi, inlineTag).replace(AZURE_FORMAT_CHARACTERS, ''))
  }
  return text
}

function azureProseVariants(fragment) {
  return [...new Set([azureProseText(fragment, ' '), azureProseText(fragment, '')])]
}

function azurePrecisionPhrase(variants) {
  for (const text of variants) {
    const match = text.match(AZURE_FOOTNOTE_PRECISION_PATTERN)
    if (match) return match[0]
  }
  return undefined
}

function azureFootnoteRegion(html, tableEnd) {
  const rest = html.slice(tableEnd)
  const boundary = rest.search(/<(?:h[1-6]|table)\b/i)
  const region = stripComments(boundary === -1 ? rest : rest.slice(0, boundary))
  const starts = [...region.matchAll(/<p\b[^>]*>\s*<sup>(\d+)<\/sup>/gi)]
  const footnotes = new Map()
  let ownEnd = region.length
  for (const [index, start] of starts.entries()) {
    const body = start.index + start[0].length
    const end = starts[index + 1]?.index ?? region.length
    const close = region.slice(body, end).match(/<\/p\s*>/i)
    ownEnd = close ? body + close.index + close[0].length : end
    const footnote = {
      own: azureProseVariants(region.slice(body, close ? body + close.index : end)),
      span: azureProseVariants(region.slice(body, end)),
    }
    footnotes.set(start[1], footnotes.has(start[1]) ? null : footnote)
  }
  const notes = azureProseVariants(region.slice(0, starts[0]?.index ?? region.length))
  return { footnotes, notes, tail: azureProseVariants(region.slice(ownEnd)), variants: azureProseVariants(region) }
}

function azureDateScan(variants, where) {
  const dates = new Set()
  for (const text of variants) {
    let candidates
    try {
      candidates = dateCandidates(text)
    } catch (error) {
      throw new Error(`${where} has an ${error.message}`)
    }
    let rest = ''
    let cursor = 0
    for (const candidate of candidates) {
      dates.add(candidate.date)
      if (candidate.index < cursor) continue
      rest += `${text.slice(cursor, candidate.index)} `
      cursor = candidate.index + text.slice(candidate.index).match(/^[\s\S]*?\b(?:19|20)\d{2}\b/)[0].length
    }
    rest += text.slice(cursor)
    const year = rest.match(AZURE_YEAR)
    if (year) throw new Error(`${where} has a date in an unrecognised format: "${rest.slice(Math.max(0, year.index - 30), year.index + 10).trim()}"`)
  }
  return dates
}

function azureCheckOtherDates(dates, date, where, now) {
  for (const other of [...dates].sort()) {
    if (other === date) continue
    if (other > date) throw new Error(`${where} states a later date ${other}`)
    const day = now === undefined ? undefined : new Date(now)
    if (!day || Number.isNaN(day.getTime())) throw new Error(`${where} states an earlier date, but the parser has no valid refresh day`)
    const today = day.toISOString().slice(0, 10)
    if (other >= today) throw new Error(`${where} states an earlier date ${other} that is not past on ${today}`)
  }
}

/** For a table offset, the prose of its own section before it and the intro of each enclosing section below the page title. */
function azureSectionPrologues(html) {
  const blank = match => ' '.repeat(match.length)
  const outside = blankOutermostTables(String(html).replace(/<!--[\s\S]*?--!?>/g, blank))
  const headings = [...outside.matchAll(/<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi)]
    .map(match => ({ start: match.index, end: match.index + match[0].length, level: Number(match[1]) }))
  return tableStart => {
    const nearest = headings.findLastIndex(heading => heading.end <= tableStart)
    if (nearest < 0) return azureProseVariants(outside.slice(0, tableStart))
    const parts = [outside.slice(headings[nearest].end, tableStart)]
    let level = headings[nearest].level
    for (let index = nearest - 1; index >= 0 && level > 2; index--) {
      if (headings[index].level >= level) continue
      level = headings[index].level
      if (level > 1) parts.push(outside.slice(headings[index].end, headings[index + 1].start))
    }
    return azureProseVariants(parts.join(' '))
  }
}

function azureRetirementDate(cell, label, region, now) {
  const marked = cell.html.match(/^\s*(\d{4}-\d{2}-\d{2})\s*<sup>(\d+)<\/sup>\s*$/i)
  const prefix = `azure-ai-foundry lifecycle entry ${label} retirement`
  const proseCheck = () => {
    const cites = marked ? `cites footnote ${marked[2]}` : 'is dated'
    const before = azurePrecisionPhrase(region().before)
    if (before) throw new Error(`${prefix} ${cites}, and the section before the table makes dates approximate ("${before}")`)
    const after = azurePrecisionPhrase(region().variants)
    if (after) throw new Error(`${prefix} ${cites}, and the notes after the table make dates approximate ("${after}")`)
  }
  if (!marked) {
    if (cell.text === '-') return undefined
    const date = azureIsoDate(cell.text, `${label} retirement`)
    proseCheck()
    return date
  }
  const date = azureIsoDate(marked[1], `${label} retirement`)
  const number = marked[2]
  const where = `${prefix} footnote ${number}`
  const footnote = region().footnotes.get(number)
  if (footnote === undefined) throw new Error(`${prefix} cites footnote ${number}, which the table does not define`)
  if (footnote === null) throw new Error(`${prefix} cites footnote ${number}, which the table defines more than once`)
  const phrase = azurePrecisionPhrase(footnote.span)
  if (phrase) throw new Error(`${where} makes the date approximate ("${phrase}"): ${footnote.span[0]}`)
  proseCheck()
  if (!azureDateScan(footnote.own, where).has(date)) throw new Error(`${where} does not state the retirement date ${date}`)
  azureCheckOtherDates(azureDateScan(footnote.span, where), date, where, now)
  const notes = `${prefix} cites footnote ${number}, and the notes before the first footnote`
  azureCheckOtherDates(azureDateScan(region().notes, notes), date, notes, now)
  const tail = `${prefix} cites footnote ${number}, and the notes after the last footnote`
  azureCheckOtherDates(azureDateScan(region().tail, tail), date, tail, now)
  return date
}

export function parseAzureModelRetirementScheduleHtml(html, { now } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('azure-ai-foundry lifecycle page is empty')
  let group = ''
  let section = ''
  let recognisedTables = 0
  const unique = new Map()
  const conflicts = []
  const modelRowCounts = new Map()
  const pageRows = []
  const prologues = azureSectionPrologues(html)
  const blocks = html.matchAll(/<(h[123]|table)\b[^>]*>([\s\S]*?)<\/\1>/gi)
  for (const block of blocks) {
    const tag = block[1].toLowerCase()
    if (tag !== 'table') {
      if (tag === 'h3') section = plainText(block[2])
      else {
        group = plainText(block[2])
        section = ''
      }
      continue
    }
    const rows = expandRows(tableRows(block[2]))
    const headers = azureHeaderIndexes(rows)
    if (!headers) continue
    recognisedTables++
    let tableRecords = 0
    let tableRegion
    const region = () => (tableRegion ??= { ...azureFootnoteRegion(html, block.index + block[0].length), before: prologues(block.index) })
    for (const row of rows.slice(headers.row + 1)) {
      if (!row.cells.some(cell => cell.text)) continue
      const [modelCell, versionCell, lifecycleCell, retirementCell] = headers.indexes.map(index => row.cells[index])
      const label = `${section || '(missing section)'}/${modelCell?.text || '(empty)'} version ${versionCell?.text || '(empty)'}`
      if (!section) throw new Error(`azure-ai-foundry lifecycle entry ${label} is missing a publisher section`)
      if (row.cells.length !== headers.indexes.length) {
        throw new Error(`azure-ai-foundry lifecycle entry ${label} is missing lifecycle columns or has extra cells`)
      }
      const modelId = modelCell.text.replace(/\s*\([^()]*\)\s*$/, '').trim()
      const publisher = AZURE_PUBLISHER_BY_SECTION.get(section)
      const validId = MODEL_ID_PATTERN.test(modelId)
      if (!validId && publisher) throw new Error(`azure-ai-foundry lifecycle entry ${label} has an invalid model id`)
      const version = versionCell.text
      const datedVersion = /^\d{4}-\d{2}-\d{2}$/.test(version)
      const hostingVersion = publisher === 'mistral' || publisher === 'cohere'
      const supportedVersion = publisher === 'openai' ? /^(?:\d{4}|1|2|001|-)$/ : /^(?:\d+|-)$/
      if (datedVersion && !hostingVersion) azureIsoDate(version, `${label} version`)
      else if (!supportedVersion.test(version)) {
        throw new Error(`azure-ai-foundry lifecycle entry ${label} has an unsupported version: ${version || '(empty)'}`)
      }
      const lifecycle = lifecycleCell.text
      const status = AZURE_LIFECYCLE_STATUSES.get(lifecycle)
      if (!status) throw new Error(`azure-ai-foundry lifecycle entry ${label} has an unsupported lifecycle status: ${lifecycle || '(empty)'}`)
      const shutdown = azureRetirementDate(retirementCell, label, region, now)
      const snapshotVersion = publisher === 'openai' && (datedVersion || /^\d{4}$/.test(version))
      const azureId = snapshotVersion ? `${modelId}-${version}` : modelId
      const record = { azureId, modelId, version, group, section, lifecycle, status }
      const modelRowKey = modelId.trim().toLowerCase()
      if (publisher === 'openai') modelRowCounts.set(modelRowKey, (modelRowCounts.get(modelRowKey) ?? 0) + 1)
      if (publisher) record.publisher = publisher
      if (!validId) record.reason = 'invalid model id'
      if (shutdown !== undefined) record.shutdown = shutdown
      pageRows.push(record)
      const key = JSON.stringify(publisher ? [section, azureId] : [group, section, azureId, version])
      const previous = unique.get(key)
      if (!previous) unique.set(key, record)
      else if (previous.shutdown !== shutdown || previous.lifecycle !== lifecycle) {
        if (hostingVersion) throw new Error(`azure-ai-foundry lifecycle entry ${label} has conflicting rows`)
        if (!previous.shutdown || !shutdown || previous.shutdown === shutdown) {
          throw new Error(`azure-ai-foundry lifecycle entry ${label} has conflicting rows without distinct retirement dates`)
        }
        const kept = previous.shutdown < shutdown ? previous : record
        const discarded = kept === previous ? record : previous
        conflicts.push({ via: 'azure-ai-foundry', section, id: azureId, kept, discarded })
        unique.set(key, kept)
      }
      tableRecords++
    }
    if (!tableRecords) throw new Error(`azure-ai-foundry lifecycle table for ${section} has no model entries`)
  }
  if (!recognisedTables) throw new Error('azure-ai-foundry lifecycle page has no recognised lifecycle table')
  for (const record of unique.values()) {
    if (record.publisher === 'openai') record.modelRowCount = modelRowCounts.get(record.modelId.trim().toLowerCase())
  }
  return { records: [...unique.values()], conflicts, rows: pageRows }
}

const MARKDOWN_LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/
const AZURE_RESERVED_CHARACTERS = /[\uE000\uE001]/

// Learn writes footnote markers as ^N^; outside code spans they become the <sup>N</sup> of the HTML page.
function azureInlineHtml(text) {
  return refuseEscapedTags(markdownCellHtml(text.replace(/(?<!\\)\^(\d+)\^/g, '\uE000$1\uE001')), 'azure-ai-foundry lifecycle', text).replace(
    /<code>[\s\S]*?<\/code>|\uE000(\d+)\uE001/g,
    (match, number) => number === undefined ? match.replace(/\uE000(\d+)\uE001/g, '^$1^') : `<sup>${number}</sup>`,
  )
}

/** Render the Azure retirement schedule's Markdown as the headings, paragraphs, and tables that parseAzureModelRetirementScheduleHtml reads. */
export function azureMarkdownToHtml(markdown) {
  const label = 'azure-ai-foundry lifecycle'
  if (typeof markdown === 'string' && AZURE_RESERVED_CHARACTERS.test(markdown)) {
    throw new Error(`${label} page contains U+E000 or U+E001, which the Markdown reader reserves for footnote markers`)
  }
  const { tableAt, lines } = markdownPageLines(markdown, label)
  const html = []
  let block
  const flush = () => {
    if (block) html.push(`<${block.tag}>${azureInlineHtml(block.lines.join('\n'))}</${block.tag}>`)
    block = undefined
  }
  for (let index = 0; index < lines.length; index++) {
    const table = tableAt.get(index)
    const line = lines[index]
    if (table) {
      flush()
      html.push(markdownPipeTableToHtml(table, { cellHtml: azureInlineHtml }))
      index += table.rows.length + 1
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (block?.tag === 'p' && isSetextUnderline(line)) {
      throw new Error(`${label} page line ${index + 1}: setext heading; section headings must use #`)
    }
    const heading = markdownHeading(line)
    const item = line.match(MARKDOWN_LIST_ITEM)
    if (heading) {
      flush()
      html.push(headingHtml(heading, azureInlineHtml(heading.text)))
    } else if (MARKDOWN_THEMATIC_BREAK.test(line)) {
      flush()
    } else if (item) {
      flush()
      block = { tag: 'li', lines: [line.slice(item[0].length).trim()] }
    } else if (block) {
      block.lines.push(line.trim())
    } else {
      block = { tag: 'p', lines: [line.trim()] }
    }
  }
  flush()
  return html.join('\n')
}

/** Parse the Markdown copy of the Azure retirement schedule with the same rules as the HTML page. */
export function parseAzureModelRetirementScheduleMarkdown(markdown, options = {}) {
  return parseAzureModelRetirementScheduleHtml(azureMarkdownToHtml(markdown), options)
}

export function sourceConflictSummary(conflict) {
  if (conflict.source === 'models-api') return azureModelsApiConflictSummary(conflict)
  if (conflict.via === 'aws-bedrock') {
    return `${conflict.via} ${conflict.id}: kept ${conflict.kept.eol ?? conflict.kept.shutdown} (${conflict.kept.source}); discarded ${conflict.discarded.shutdown} (${conflict.discarded.source}); legacy table wins`
  }
  const row = item => `${item.shutdown} (${item.lifecycle}, version ${item.version})`
  return `${conflict.via} ${conflict.section}/${conflict.id}: kept ${row(conflict.kept)}; discarded ${row(conflict.discarded)}; earliest retirement wins`
}

const PUBLISHER_BY_NAMESPACE = new Map([
  ['anthropic', 'anthropic'],
  ['amazon', 'amazon'],
  ['openai', 'openai'],
  ['google', 'google'],
  ['cohere', 'cohere'],
  ['mistral', 'mistral'],
])

function sourceNamespace(value, via) {
  if (via === 'aws-bedrock') return value.match(/^([^.]+)\./)?.[1].toLowerCase()
  return value.match(/^publishers\/([^/]+)\/models\//i)?.[1].toLowerCase()
}

function expectedPublisher(namespace) {
  return namespace ? PUBLISHER_BY_NAMESPACE.get(namespace) : undefined
}

/** Convert a Bedrock model ID to the publisher ID used by a feed. */
export function normalizeBedrockId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Bedrock model id must be a non-empty string')
  }
  const input = value.trim()
  const separator = input.indexOf('.')
  const withoutProvider = separator > 0 ? input.slice(separator + 1) : input
  const normalized = withoutProvider.replace(/(?:-v\d+(?::\d+)?|:\d+)$/i, '')
  if (!normalized) throw new Error(`Bedrock model id has no publisher portion: ${value}`)
  return normalized
}

export const normaliseBedrockId = normalizeBedrockId

export function normalizeVertexId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Vertex model id must be a non-empty string')
  }
  return value.trim().replace(/^publishers\/[^/]+\/models\//, '')
}

export const normaliseVertexId = normalizeVertexId

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function feedParts(feeds) {
  if (Array.isArray(feeds)) return feeds.map((item, index) => {
    if (item?.feed && Array.isArray(item.feed.models)) {
      return { feed: item.feed, publisher: item.provider?.publisher ?? item.feed.publisher ?? `feed-${index}` }
    }
    if (item && Array.isArray(item.models)) return { feed: item, publisher: item.publisher ?? `feed-${index}` }
    throw new Error('distributor merge received a feed without a models array')
  })
  if (feeds && typeof feeds === 'object') return feedParts(Object.values(feeds))
  throw new Error('distributor merge requires one or more publisher feeds')
}

function dateField(value, field, modelId, via) {
  if (value === undefined) return undefined
  try {
    assertIsoDate(value, `${via} record ${modelId} ${field}`)
  } catch {
    throw new Error(`${via} record ${modelId} has an invalid ${field} date`)
  }
  return value
}

function precisionField(value, modelId, via) {
  if (value === undefined) return undefined
  if (!['exact', 'earliest', 'tentative'].includes(value)) {
    throw new Error(`${via} record ${modelId} has an invalid date_precision`)
  }
  return value
}

function statusField(value, modelId, via) {
  if (value === undefined) return undefined
  if (!['active', 'legacy', 'extended-access', 'retired'].includes(value)) {
    throw new Error(`${via} record ${modelId} has an invalid status`)
  }
  return value
}

function recordForMerge(record, via) {
  const isBedrock = via === 'aws-bedrock'
  const isAzure = via === 'azure-ai-foundry'
  const idField = isBedrock ? 'bedrockId' : isAzure ? 'azureId' : 'vertexId'
  const rawId = isBedrock ? record?.bedrockId : isAzure ? record?.azureId : record?.vertexId ?? record?.modelId ?? record?.id
  const publisher = isAzure ? AZURE_PUBLISHER_BY_SECTION.get(record?.section) : undefined
  if (typeof rawId !== 'string' || (!rawId.trim() && (!isAzure || publisher))) {
    throw new Error(`${via} record is missing ${idField}`)
  }
  const sourceId = rawId.trim()
  const announcedValue = isBedrock ? record.legacy : record.announced
  const shutdownValue = isBedrock ? record.eol ?? record.shutdown : record.shutdown ?? record.retirement
  const announced = dateField(announcedValue, isBedrock ? 'legacy' : 'announced', sourceId, via)
  const shutdown = dateField(shutdownValue, isBedrock ? 'EOL' : 'retirement', sourceId, via)
  if (announced && shutdown && shutdown < announced) {
    throw new Error(`${via} record ${sourceId} has shutdown before announced`)
  }
  const namespace = isAzure ? record.section : sourceNamespace(sourceId, via)
  return {
    idField,
    sourceId,
    namespace,
    expectedPublisher: isAzure ? publisher : expectedPublisher(namespace),
    normalizedId: isBedrock ? normalizeBedrockId(sourceId) : isAzure
      ? publisher === 'cohere' ? sourceId.replace(/^(?:Cohere|cohere)-/, '') : sourceId
      : normalizeVertexId(sourceId),
    announced,
    shutdown,
    date_precision: precisionField(record.date_precision, sourceId, via),
    status: statusField(record.status, sourceId, via),
  }
}

function withoutDistributions(model) {
  const copy = clone(model)
  delete copy.distributions
  return copy
}

function distributionFor(model, via) {
  const distributions = Array.isArray(model.distributions) ? model.distributions : []
  const indexes = distributions
    .map((distribution, index) => distribution?.via === via ? index : -1)
    .filter(index => index >= 0)
  if (indexes.length > 1) throw new Error(`model ${model.id} has duplicate ${via} distributions`)
  return indexes.length ? { index: indexes[0], value: distributions[indexes[0]] } : undefined
}

function assertDistributorPreserved(before, after, via) {
  const afterById = new Map((after.models ?? []).map(model => [model.id, model]))
  for (const oldModel of before.models ?? []) {
    const nextModel = afterById.get(oldModel.id)
    if (!nextModel) throw new Error(`${via} merge would drop committed model ${oldModel.id}`)
    if (JSON.stringify(withoutDistributions(oldModel)) !== JSON.stringify(withoutDistributions(nextModel))) {
      throw new Error(`${via} merge modified entry-level fields for ${oldModel.id}`)
    }
    const oldForeign = (oldModel.distributions ?? []).filter(distribution => distribution?.via !== via)
    const nextForeign = (nextModel.distributions ?? []).filter(distribution => distribution?.via !== via)
    if (JSON.stringify(oldForeign) !== JSON.stringify(nextForeign)) {
      throw new Error(`${via} merge modified foreign distributions for ${oldModel.id}`)
    }
  }
}

// Upsert one distributor clock across loaded publisher feeds.
export function mergeDistributions(feeds, {
  records = [],
  sourceUrl,
  via,
} = {}) {
  if (typeof via === 'string' && ['publisher', 'publisher-fallback'].includes(via.toLowerCase())) {
    throw new Error(`reserved distributor clock ${via}`)
  }
  if (!via || !DISTRIBUTORS[via]) throw new Error(`unknown distributor ${via || '(empty)'}`)
  const config = DISTRIBUTORS[via]
  const source = sourceUrl ?? config.sourceUrl
  try {
    new URL(source)
  } catch {
    throw new Error(`${via} source is not a URL: ${source}`)
  }
  if (!Array.isArray(records)) throw new Error(`${via} merge records must be an array`)

  const parts = feedParts(feeds)
  const working = parts.map(part => ({
    publisher: part.publisher,
    before: clone(part.feed),
    feed: clone(part.feed),
  }))
  const identity = new Map()
  for (const [feedIndex, part] of working.entries()) {
    for (const model of part.feed.models) {
      for (const key of [model.id, ...(model.aliases ?? [])]) {
        if (!key) continue
        const previous = identity.get(key)
        if (previous && (previous.model !== model || previous.feedIndex !== feedIndex)) {
          throw new Error(`publisher feeds have an ambiguous id or alias: ${key}`)
        }
        identity.set(key, { feedIndex, model, publisher: part.publisher })
      }
    }
  }

  const unmatched = []
  const unconfirmedDistributions = []
  const confirmed = new Set()
  const matchedRecords = new Map()
  const conflicts = []
  for (const raw of records) {
    const record = recordForMerge(raw, via)
    const unmatchedItem = { normalizedId: record.normalizedId, [record.idField]: record.sourceId }
    if (record.idField === 'azureId') {
      unmatchedItem.section = raw.section
      if (raw.reason) unmatchedItem.reason = raw.reason
    }
    if (record.idField === 'vertexId') unmatchedItem.modelId = record.sourceId
    if ((via === 'azure-ai-foundry' || record.namespace) && !record.expectedPublisher) {
      unmatched.push(unmatchedItem)
      continue
    }
    let target = identity.get(record.normalizedId)
    if (!target && via === 'azure-ai-foundry' && record.expectedPublisher === 'openai' &&
      /^\d{4}-\d{2}-\d{2}$/.test(raw.version) && raw.modelRowCount === 1) {
      const bare = identity.get(raw.modelId)
      if (bare?.publisher === 'openai' && bare.model.id === raw.modelId) {
        const prefix = `${raw.modelId}-`
        const hasSnapshot = working[bare.feedIndex].feed.models.some(model =>
          [model.id, ...(model.aliases ?? [])].some(id => id.startsWith(prefix) && /^(?:\d{4}-\d{2}-\d{2}|\d{4})$/.test(id.slice(prefix.length))))
        if (!hasSnapshot) target = bare
      }
    }
    if (!target) {
      if (via === 'azure-ai-foundry') {
        unconfirmedDistributions.push({
          publisher: record.expectedPublisher,
          id: record.normalizedId,
          via,
          reason: 'source model is absent from publisher feed',
        })
      } else unmatched.push(unmatchedItem)
      continue
    }
    if (record.expectedPublisher && target.publisher !== record.expectedPublisher) {
      throw new Error(`${via} namespace ${record.namespace} binds to ${record.expectedPublisher}, but normalized id ${record.normalizedId} matched the ${target.publisher} feed`)
    }

    const targetKey = `${target.feedIndex}:${target.model.id}`
    const recordSource = raw.source ?? source
    try {
      new URL(recordSource)
    } catch {
      throw new Error(`${via} record ${record.sourceId} source is not a URL: ${recordSource}`)
    }
    const matched = matchedRecords.get(targetKey) ?? { target, legacy: [], other: [] }
    const group = via === 'aws-bedrock' && recordSource === BEDROCK_LIFECYCLE_URL ? matched.legacy : matched.other
    const priorRecord = group[0]
    if (priorRecord && !sameLifecycle(priorRecord, record)) {
      throw new Error(`${via} records ${priorRecord.sourceId} and ${record.sourceId} map to ${target.model.id} with conflicting lifecycle data`)
    }
    group.push({ ...record, source: recordSource, raw })
    matchedRecords.set(targetKey, matched)
  }

  for (const [targetKey, { target, legacy, other }] of matchedRecords) {
    const record = legacy[0] ?? other[0]
    if (legacy.length) {
      for (const card of other) {
        if ([record, card].every(item => item.shutdown && (!item.date_precision || item.date_precision === 'exact')) && record.shutdown !== card.shutdown) {
          conflicts.push({ via, id: record.sourceId, kept: { ...record.raw, source: record.source }, discarded: { ...card.raw, source: card.source } })
        }
      }
    }
    const existing = distributionFor(target.model, via)
    const distribution = { via }
    if (record.announced !== undefined) distribution.announced = record.announced
    if (record.shutdown !== undefined) distribution.shutdown = record.shutdown
    if (record.date_precision !== undefined) distribution.date_precision = record.date_precision
    if (record.status !== undefined) distribution.status = record.status
    distribution.source = record.source
    if (existing) {
      target.model.distributions[existing.index] = distribution
    } else {
      if (!Array.isArray(target.model.distributions)) target.model.distributions = []
      target.model.distributions.push(distribution)
    }
    confirmed.add(targetKey)
  }

  for (const [feedIndex, part] of working.entries()) {
    for (const model of part.feed.models) {
      const existing = distributionFor(model, via)
      const key = `${feedIndex}:${model.id}`
      if (existing && !confirmed.has(key)) {
        unconfirmedDistributions.push({
          publisher: part.publisher,
          id: model.id,
          via,
          distribution: clone(existing.value),
        })
      }
    }
    assertDistributorPreserved(part.before, part.feed, via)
  }

  unmatched.sort((a, b) => `${a.bedrockId ?? a.vertexId ?? a.azureId}`.localeCompare(`${b.bedrockId ?? b.vertexId ?? b.azureId}`))
  unconfirmedDistributions.sort((a, b) => `${a.publisher}:${a.id}`.localeCompare(`${b.publisher}:${b.id}`))
  return {
    feeds: working.map(part => part.feed),
    noPublisherFeed: unmatched,
    noPublisherFeeds: unmatched,
    unconfirmedDistributions,
    conflicts,
  }
}

export function mergeBedrockDistributions(feeds, options = {}) {
  return mergeDistributions(feeds, {
    ...options,
    via: options.via ?? 'aws-bedrock',
    sourceUrl: options.sourceUrl ?? BEDROCK_LIFECYCLE_URL,
  })
}

export function mergeVertexDistributions(feeds, options = {}) {
  return mergeDistributions(feeds, {
    ...options,
    via: options.via ?? 'vertex-ai',
    sourceUrl: options.sourceUrl ?? VERTEX_MODEL_VERSIONS_URL,
  })
}

export function findDistributorFixture(dir, distributor = 'aws-bedrock') {
  const config = DISTRIBUTORS[distributor]
  if (!config) throw new Error(`unknown distributor ${distributor}`)
  if (!dir) return undefined
  const root = path.resolve(dir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`fixtures directory does not exist: ${dir}`)
  }
  const extension = path.extname(config.fixture)
  const candidates = [config.fixture, `${distributor}${extension}`, `${distributor}-lifecycle${extension}`]
  for (const filename of candidates) {
    const candidate = path.join(root, filename)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`missing ${distributor} fixture in ${dir}`)
}

function readBedrockCardFixture(dir, filename, url) {
  try {
    return fs.readFileSync(path.join(dir, filename), 'utf8')
  } catch (error) {
    throw new Error(`aws-bedrock missing or unreadable fixture ${filename} for ${url}: ${error.message}`)
  }
}

async function fetchBedrockCard(url, config, options) {
  try {
    return await fetchBody(bedrockMarkdownUrl(url), config.name, options.fetchImpl)
  } catch (error) {
    throw new Error(`aws-bedrock model card ${url}: ${error.message}`)
  }
}

async function loadBedrockCards(config, options) {
  const index = options.fixtures
    ? readBedrockCardFixture(options.fixtures, config.indexFixture, config.indexUrl)
    : await fetchBody(config.indexFetchUrl, config.name, options.fetchImpl)
  const records = []
  const skipped = []
  for (const url of parseBedrockModelCardsIndexMarkdown(index)) {
    const markdown = options.fixtures
      ? readBedrockCardFixture(options.fixtures, path.join(config.cardFixtureDir, path.basename(new URL(bedrockMarkdownUrl(url)).pathname)), url)
      : await fetchBedrockCard(url, config, options)
    const parsed = parseBedrockModelCardMarkdown(markdown, url)
    records.push(...parsed.records)
    skipped.push(...parsed.skipped)
  }
  return { records, skipped }
}

/** MODEL_EOL_CROSS_CHECKS=strict makes a failed cross-check fail the run; unset, empty, or warn reports it and goes on. */
export function crossChecksStrict(env = process.env) {
  const value = env.MODEL_EOL_CROSS_CHECKS ?? ''
  if (value === 'strict') return true
  if (value === '' || value === 'warn') return false
  throw new Error(`MODEL_EOL_CROSS_CHECKS must be strict, warn, or unset, not ${JSON.stringify(value)}`)
}

export async function loadDistributorSource(distributor = 'aws-bedrock', options = {}) {
  const config = DISTRIBUTORS[distributor]
  if (!config) throw new Error(`unknown distributor ${distributor}`)
  let html
  let fixturePath
  if (options.fixtures) {
    fixturePath = findDistributorFixture(options.fixtures, distributor)
    html = fs.readFileSync(fixturePath, 'utf8')
    ;(options.notice ?? console.error)(`notice: ${distributor} lifecycle fixture: ${path.relative(process.cwd(), fixturePath)}`)
  } else {
    html = await fetchBody(config.sourceFetchUrl ?? config.sourceUrl, distributor, options.fetchImpl, { headers: { ...config.sourceHeaders } })
  }
  const notice = options.notice ?? console.error
  let parsed = distributor === 'azure-ai-foundry'
    ? parseAzureModelRetirementScheduleMarkdown(html, { now: options.now ?? new Date() })
    : { records: distributor === 'aws-bedrock' ? parseBedrockLifecycleMarkdown(html) : parseVertexModelVersionsMarkdown(html) }
  if (distributor === 'aws-bedrock') {
    const cards = await loadBedrockCards(config, options)
    parsed = { ...mergeBedrockSources(parsed.records, cards.records), skipped: cards.skipped }
  }
  let apiSummary
  if (distributor === 'azure-ai-foundry') {
    const env = options.env ?? process.env
    const strict = crossChecksStrict(env)
    let credentials
    try {
      credentials = options.fixtures ? undefined : azureModelsApiCredentials(env)
      if (options.fixtures) notice('notice: azure models API not read in a fixture run')
      else if (!credentials) notice('notice: azure models API skipped: AZURE_MANAGEMENT_TOKEN and AZURE_SUBSCRIPTION_ID are not set')
      else {
        const api = await fetchAzureModelsApi(credentials, { fetchImpl: options.fetchImpl, locations: options.azureLocations })
        const reconciled = reconcileAzureModelsApi(parsed.records, api.entries, { rows: parsed.rows })
        parsed = { ...parsed, records: reconciled.records, conflicts: [...parsed.conflicts, ...reconciled.conflicts] }
        apiSummary = azureModelsApiSummary(api, reconciled.conflicts)
      }
    } catch (error) {
      if (strict) throw error
      // The API only cross-checks the page and never changes feed data, so by default its failure is reported, not fatal.
      const message = redactAzureModelsApiMessage(error.message, credentials).replace(/\s+/g, ' ')
      notice(`warning: azure models API cross-check failed: ${message}`)
      parsed = { ...parsed, conflicts: [...parsed.conflicts, { via: 'azure-ai-foundry', source: 'models-api', reason: 'cross-check-failed', message }] }
    }
  }
  const conflicts = parsed.conflicts ?? []
  for (const conflict of conflicts) if (!isAzureModelsApiOneDay(conflict)) notice(`notice: ${sourceConflictSummary(conflict)}`)
  if (conflicts.some(isAzureModelsApiOneDay)) notice(`notice: ${azureModelsApiOneDaySummary(conflicts)}`)
  if (apiSummary) notice(`notice: ${apiSummary}`)
  for (const card of parsed.skipped ?? []) notice(`notice: ${skippedModelCardSummary(card)}`)
  return {
    ...config,
    fixturePath,
    ...parsed,
  }
}
