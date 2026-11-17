#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCliArgs } from '../lib/cli.mjs'
import { DISTRIBUTORS, findDistributorFixture } from './distributors.mjs'
import { fetchBoundedBody } from './fetch.mjs'
import {
  PROVIDERS,
  findFixture,
  googleInlineText,
  googleMarkdocRows,
  plainText,
  stripComments,
  stripFencedCodeBlocks,
} from './providers.mjs'

const THIS_FILE = fileURLToPath(import.meta.url)
const ROOT = path.join(path.dirname(THIS_FILE), '..')
export const SNAPSHOT_FILE = path.join(ROOT, 'refresh', 'source-shapes.json')
export const SNAPSHOT_VERSION = 1

/** Every page the refresh parsers read tables from, except the per-model Bedrock cards and the models APIs. */
export function shapeSources() {
  const providers = Object.entries(PROVIDERS).map(([name, config]) => {
    const url = config.deprecationsFetchUrl ?? config.deprecationsUrl
    return { name, kind: 'provider', url, format: /\.md$/i.test(new URL(url).pathname) ? 'markdoc' : 'html' }
  })
  const distributors = Object.entries(DISTRIBUTORS).map(([name, config]) => (
    { name, kind: 'distributor', url: config.sourceUrl, format: 'html' }
  ))
  return [...providers, ...distributors].sort((left, right) => left.name.localeCompare(right.name))
}

export function normalizeHeaderText(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[`|]/g, match => (match === '|' ? '/' : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const signature = rows => rows.map(row => row.join(' | ')).join(' || ')
const headerless = columns => `(no header row, ${columns} columns)`

function htmlCells(rowHtml) {
  return [...rowHtml.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)].map(cell => ({
    kind: cell[1].toLowerCase(),
    columns: Math.max(1, Number(cell[2].match(/\bcolspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1)),
    text: normalizeHeaderText(plainText(cell[3])),
  }))
}

function htmlRows(fragment) {
  const rows = [...fragment.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(row => htmlCells(row[1]))
  if (!rows.length && /<t[hd]\b/i.test(fragment)) rows.push(htmlCells(fragment))
  return rows.filter(row => row.length)
}

function htmlTableShape(body) {
  const thead = body.match(/<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/i)
  let header = thead ? htmlRows(thead[1]) : []
  const rows = htmlRows(thead ? body.replace(thead[0], '') : body)
  if (!header.length) {
    const count = rows.findIndex(row => row.some(cell => cell.kind !== 'th'))
    header = rows.slice(0, count < 0 ? 1 : count)
  }
  if (header.length) return signature(header.map(row => row.map(cell => cell.text)))
  const first = rows[0]
  return first ? headerless(first.reduce((sum, cell) => sum + cell.columns, 0)) : '(empty table)'
}

/** Distinct header signatures of every HTML table, innermost tables first so a nested table never hides its parent. */
export function htmlTableShapes(html) {
  let text = stripComments(String(html)).replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const shapes = new Set()
  const innermost = /<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table\s*>/gi
  for (let found = true; found;) {
    found = false
    text = text.replace(innermost, (_, body) => {
      found = true
      shapes.add(htmlTableShape(body))
      return ' '
    })
  }
  if (/<\/?table\b/i.test(text)) throw new Error('page has an unbalanced <table> tag')
  return [...shapes].sort()
}

const markdocHeaderText = cell => normalizeHeaderText(googleInlineText(cell.replace(/\[([^\]]*)\]\([^()\s]*\)/g, '$1')))

/** Distinct header-row signatures of every Markdoc {% table %} block. */
export function markdocTableShapes(markdown) {
  const shapes = new Set()
  let table
  let where = 'before the first heading'
  for (const line of stripFencedCodeBlocks(stripComments(String(markdown))).split('\n')) {
    const trimmed = line.trim()
    const tag = /\{%\s*\/?\s*table\b/.test(trimmed)
    if (table) {
      if (trimmed === '{% /table %}') {
        const [header = []] = googleMarkdocRows(table, where)
        shapes.add(signature([header.map(markdocHeaderText)]))
        table = undefined
      } else if (tag) {
        throw new Error(`table ${where} has a nested or malformed table tag: ${trimmed}`)
      } else {
        table.push(line)
      }
      continue
    }
    if (trimmed === '{% table %}') table = []
    else if (tag) throw new Error(`page has a malformed table tag ${where}: ${trimmed}`)
    else if (/^#{1,6}\s/.test(line)) where = `under "${line.replace(/^#+\s*|\s*\{%[^%]*%\}\s*$/g, '').trim()}"`
  }
  if (table) throw new Error(`table ${where} is not closed`)
  return [...shapes].sort()
}

export function extractShapes(body, format) {
  const shapes = format === 'markdoc' ? markdocTableShapes(body) : htmlTableShapes(body)
  if (!shapes.length) throw new Error('no tables found')
  return shapes
}

function readFixture(source, dir) {
  const file = source.kind === 'provider'
    ? findFixture(dir, source.name, 'deprecations')
    : findDistributorFixture(dir, source.name)
  return fs.readFileSync(file, 'utf8')
}

/** Fetch every source concurrently; returns { shapes, failures } so one bad source never hides another. */
export async function collectShapes(sources = shapeSources(), { fixtures, fetchImpl = globalThis.fetch } = {}) {
  const results = await Promise.allSettled(sources.map(async source => {
    const body = fixtures ? readFixture(source, fixtures) : await fetchBoundedBody(source.url, source.name, fetchImpl)
    return extractShapes(body, source.format)
  }))
  const shapes = {}
  const failures = []
  for (const [index, result] of results.entries()) {
    const source = sources[index]
    if (result.status === 'fulfilled') shapes[source.name] = { url: source.url, tables: result.value }
    else failures.push({ name: source.name, url: source.url, message: result.reason?.message ?? String(result.reason) })
  }
  return { shapes, failures }
}

export function snapshotDocument(shapes) {
  const sources = {}
  for (const name of Object.keys(shapes).sort()) sources[name] = { url: shapes[name].url, tables: [...shapes[name].tables].sort() }
  return { version: SNAPSHOT_VERSION, sources }
}

export function readSnapshot(file) {
  let document
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read source shape snapshot ${file}: ${error.message}`)
  }
  const valid = document?.version === SNAPSHOT_VERSION && document.sources && typeof document.sources === 'object' &&
    Object.values(document.sources).every(source => typeof source?.url === 'string' && Array.isArray(source.tables) && source.tables.every(table => typeof table === 'string'))
  if (!valid) throw new Error(`source shape snapshot ${file} is not a version ${SNAPSHOT_VERSION} snapshot`)
  return document
}

/** Per-source differences between a snapshot and live shapes; an empty array means they match. */
export function compareShapes(snapshot, live) {
  const names = [...new Set([...Object.keys(snapshot.sources), ...Object.keys(live.sources)])].sort()
  const changes = []
  for (const name of names) {
    const before = snapshot.sources[name]
    const after = live.sources[name]
    const beforeTables = new Set(before?.tables ?? [])
    const afterTables = new Set(after?.tables ?? [])
    const change = {
      name,
      url: after?.url ?? before.url,
      previousUrl: before && after && before.url !== after.url ? before.url : undefined,
      status: !before ? 'new source' : !after ? 'source removed' : undefined,
      added: [...afterTables].filter(table => !beforeTables.has(table)).sort(),
      removed: [...beforeTables].filter(table => !afterTables.has(table)).sort(),
    }
    if (change.status || change.previousUrl || change.added.length || change.removed.length) changes.push(change)
  }
  return changes
}

const codeSpan = text => `\`${text}\``

export function renderShapeDiff(changes) {
  const output = ['# Source page structure diff', '']
  for (const change of changes) {
    output.push(`## ${change.name}`, '', `Source: ${change.url}`)
    if (change.status) output.push(`Status: ${change.status}`)
    if (change.previousUrl) output.push(`Previous source: ${change.previousUrl}`)
    output.push('')
    for (const [label, tables] of [['Header shapes added', change.added], ['Header shapes removed', change.removed]]) {
      if (!tables.length) continue
      output.push(`${label}:`, '', ...tables.map(table => `- ${codeSpan(table)}`), '')
    }
  }
  return `${output.join('\n').trimEnd()}\n`
}

export function renderFailures(failures) {
  return failures.map(failure => `source shape check failed for ${failure.name} (${failure.url}): ${failure.message}`).join('\n')
}

export function parseShapeArgs(argv = process.argv.slice(2)) {
  const { values } = parseCliArgs({
    args: argv,
    options: {
      check: { type: 'boolean' },
      write: { type: 'boolean' },
      fixtures: { type: 'string' },
      snapshot: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: 'node refresh/shapes.mjs --help',
  })
  const options = {
    check: values.check ?? false,
    write: values.write ?? false,
    fixtures: values.fixtures === undefined ? undefined : path.resolve(values.fixtures),
    snapshot: path.resolve(values.snapshot ?? SNAPSHOT_FILE),
    help: values.help ?? false,
  }
  if (!options.help && options.check === options.write) throw new Error('pass exactly one of --check or --write')
  if (options.write && options.fixtures && values.snapshot === undefined) {
    throw new Error('--write --fixtures needs an explicit --snapshot; the committed snapshot comes from live sources')
  }
  return options
}

export function usage() {
  return [
    'Usage: node refresh/shapes.mjs --check|--write [--fixtures DIR] [--snapshot FILE]',
    '',
    'Records the distinct table header shapes of every live source page the refresh parsers read.',
    '--check exits 0 when every source matches the snapshot, 3 when any differs, and 1 when a source cannot be fetched or parsed.',
    '--write regenerates the snapshot from the sources.',
  ].join('\n')
}

export async function main(argv = process.argv.slice(2), { fetchImpl, stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseShapeArgs(argv)
  if (options.help) {
    stdout.write(`${usage()}\n`)
    return 0
  }
  const snapshot = options.check ? readSnapshot(options.snapshot) : undefined
  const { shapes, failures } = await collectShapes(shapeSources(), { fixtures: options.fixtures, fetchImpl })
  if (failures.length) {
    stderr.write(`${renderFailures(failures)}\n`)
    return 1
  }
  const live = snapshotDocument(shapes)
  if (options.write) {
    const temporary = `${options.snapshot}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(live, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, options.snapshot)
    stderr.write(`wrote ${Object.keys(live.sources).length} source shapes to ${path.relative(process.cwd(), options.snapshot) || options.snapshot}\n`)
    return 0
  }
  const changes = compareShapes(snapshot, live)
  if (!changes.length) {
    stdout.write(`All ${Object.keys(live.sources).length} source pages match the structure snapshot.\n`)
    return 0
  }
  stdout.write(renderShapeDiff(changes))
  return 3
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)
if (invoked) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`source shape check failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
