#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareFeeds, renderSemanticDiff } from './diff.mjs'
import {
  PROVIDERS,
  loadProviderSources,
  mergeFeed,
} from './providers.mjs'

const THIS_FILE = fileURLToPath(import.meta.url)
const ROOT = path.join(path.dirname(THIS_FILE), '..')
const COMMITTED_FEEDS = path.join(ROOT, 'feeds')
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-feeds.mjs')

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    provider: 'all',
    check: false,
    out: path.join(ROOT, 'feeds'),
    fixtures: undefined,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') {
      options.check = true
    } else if (arg === '--provider' || arg === '--out' || arg === '--fixtures') {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      if (arg === '--provider') options.provider = value
      if (arg === '--out') options.out = value
      if (arg === '--fixtures') options.fixtures = value
    } else if (arg.startsWith('--provider=')) {
      options.provider = arg.slice('--provider='.length)
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg.startsWith('--fixtures=')) {
      options.fixtures = arg.slice('--fixtures='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }

  if (!['openai', 'anthropic', 'all'].includes(options.provider)) {
    throw new Error(`--provider must be openai, anthropic, or all`)
  }
  options.providers = options.provider === 'all' ? ['openai', 'anthropic'] : [options.provider]
  options.out = path.resolve(options.out)
  if (options.fixtures) options.fixtures = path.resolve(options.fixtures)
  return options
}

export function usage() {
  return [
    'Usage: node refresh/refresh.mjs [--provider openai|anthropic|all] [--check] [--out feeds/] [--fixtures DIR]',
    '',
    '--check exits 0 when the semantic diff is empty, 3 when it has changes, and 1 on failure.',
  ].join('\n')
}

function readCommitted(provider) {
  const file = path.join(COMMITTED_FEEDS, provider.feedFile)
  let feed
  try {
    feed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read committed feed ${file}: ${error.message}`)
  }
  if (!feed || !Array.isArray(feed.models)) throw new Error(`committed feed ${file} has no models array`)
  return feed
}

/**
 * The repository validator resolves ../feeds relative to its own file and has
 * no directory argument. Copying that unchanged validator into an isolated
 * temporary tree lets it validate generated files without touching feeds/.
 */
export function validateGeneratedFeeds(generated) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-'))
  const temporaryFeeds = path.join(temporary, 'feeds')
  const temporaryScripts = path.join(temporary, 'scripts')
  fs.mkdirSync(temporaryFeeds)
  fs.mkdirSync(temporaryScripts)
  try {
    fs.copyFileSync(VALIDATOR, path.join(temporaryScripts, 'validate-feeds.mjs'))
    for (const item of generated) {
      fs.writeFileSync(
        path.join(temporaryFeeds, item.provider.feedFile),
        `${JSON.stringify(item.feed, null, 2)}\n`,
        'utf8',
      )
    }
    try {
      execFileSync(process.execPath, [path.join(temporaryScripts, 'validate-feeds.mjs')], {
        cwd: temporary,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
      throw new Error(`generated feed validation failed${output ? `:\n${output}` : ''}`)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export async function generateProviderFeed(providerName, options = {}) {
  const provider = PROVIDERS[providerName]
  if (!provider) throw new Error(`unknown provider ${providerName}`)
  const committed = readCommitted(provider)
  const sourceProvider = {
    ...provider,
    // The committed feed is the source of truth for the docs URL. The
    // constant is only a fallback for a feed that predates this tool.
    deprecationsUrl: committed.source ?? provider.deprecationsUrl,
  }
  const sources = await loadProviderSources(sourceProvider, options)
  const merged = mergeFeed(committed, {
    deprecations: sources.deprecations,
    currentIds: sources.currentIds,
    generated: options.generated,
    provider: sourceProvider,
  })
  return {
    provider: sourceProvider,
    committed,
    feed: merged.feed,
    unconfirmedIds: merged.unconfirmedIds,
  }
}

function combinedDiff(items) {
  if (items.length === 1) return items[0].markdown
  const output = ['# Feed refresh diff', '']
  for (const item of items) {
    const body = item.markdown.replace(/^# Feed refresh diff\n\n?/, '').trim()
    output.push(`## ${item.provider.publisher}`, '', body, '')
  }
  return `${output.join('\n').trimEnd()}\n`
}

function writeGenerated(items, out) {
  fs.mkdirSync(out, { recursive: true })
  for (const item of items) {
    const target = path.join(out, item.provider.feedFile)
    const temporary = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(item.feed, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, target)
  }
}

export async function run(options) {
  const generated = []
  for (const name of options.providers) {
    generated.push(await generateProviderFeed(name, {
      fixtures: options.fixtures,
      generated: process.env.MODEL_EOL_GENERATED,
    }))
  }

  validateGeneratedFeeds(generated)

  const diffs = generated.map(item => ({
    provider: item.provider,
    result: compareFeeds(item.committed, item.feed, {
      unconfirmed: item.unconfirmedIds,
      publisher: item.provider.publisher,
    }),
    markdown: renderSemanticDiff(item.committed, item.feed, {
      unconfirmed: item.unconfirmedIds,
      publisher: item.provider.publisher,
    }),
  }))
  const changed = diffs.some(item => item.result.changed)
  const markdown = combinedDiff(diffs)
  process.stdout.write(markdown)

  if (!options.check) writeGenerated(generated, options.out)
  return { changed, markdown, generated, diffs }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }
  const result = await run(options)
  return options.check && result.changed ? 3 : 0
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)
if (invoked) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`refresh failed: ${error.message}`)
    process.exitCode = 1
  }
}
