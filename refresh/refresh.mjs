#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCliArgs } from '../lib/cli.mjs'
import { compareFeeds, renderSemanticDiff } from './diff.mjs'
import {
  DISTRIBUTORS,
  loadDistributorSource,
  mergeDistributions,
} from './distributors.mjs'
import {
  PROVIDERS,
  loadProviderSources,
  mergeFeed,
} from './providers.mjs'
import { validateFeed } from '../lib/validate-feed.mjs'

const THIS_FILE = fileURLToPath(import.meta.url)
const ROOT = path.join(path.dirname(THIS_FILE), '..')
const COMMITTED_FEEDS = path.join(ROOT, 'feeds')
const AMAZON_PROVIDER = { publisher: 'amazon', feedFile: 'amazon.json' }

export function parseRefreshArgs(argv = process.argv.slice(2)) {
  const { values } = parseCliArgs({
    args: argv,
    options: {
      provider: { type: 'string' },
      distributor: { type: 'string', multiple: true },
      check: { type: 'boolean' },
      out: { type: 'string' },
      fixtures: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: 'node refresh/refresh.mjs --help',
  })
  const options = {
    provider: values.provider ?? 'all',
    providerSpecified: values.provider !== undefined,
    distributor: undefined,
    check: values.check ?? false,
    out: values.out ?? path.join(ROOT, 'feeds'),
    fixtures: values.fixtures,
    help: values.help ?? false,
  }

  if (!['openai', 'anthropic', 'google', 'all'].includes(options.provider)) {
    throw new Error(`--provider must be openai, anthropic, google, or all`)
  }
  const distributorArgs = values.distributor ?? []
  const distributors = (Array.isArray(distributorArgs) ? distributorArgs : [distributorArgs])
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean)
  for (const distributor of distributors) {
    if (!DISTRIBUTORS[distributor]) {
      throw new Error(`--distributor must be aws-bedrock or vertex-ai`)
    }
  }
  options.distributors = [...new Set(distributors)]
  options.distributor = options.distributors.length === 1
    ? options.distributors[0]
    : options.distributors.length
      ? options.distributors.join(',')
      : undefined
  options.providers = options.provider === 'all' ? ['openai', 'anthropic', 'google'] : [options.provider]
  options.out = path.resolve(options.out)
  if (options.fixtures) options.fixtures = path.resolve(options.fixtures)
  return options
}

export function usage() {
  return [
    'Usage: node refresh/refresh.mjs [--provider openai|anthropic|google|all] [--distributor aws-bedrock[,vertex-ai]] [--check] [--out feeds/] [--fixtures DIR]',
    '',
    '--distributor accepts comma-separated values and may run standalone against committed publisher feeds, or compose with --provider.',
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

export function validateGeneratedFeeds(generated) {
  const failures = generated.flatMap(item => validateFeed(item.feed).map(error => `${item.provider.feedFile}: ${error.path}: ${error.message}`))
  if (failures.length) throw new Error(`generated feed validation failed:\n${failures.join('\n')}`)
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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function generateCommittedFeed(providerName, options = {}) {
  const provider = options.provider ?? PROVIDERS[providerName]
  if (!provider) throw new Error(`unknown provider ${providerName}`)
  const committed = readCommitted(provider)
  return {
    provider,
    committed,
    feed: {
      ...clone(committed),
      generated: options.generated ?? new Date().toISOString(),
    },
    unconfirmedIds: [],
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
  const generatedTimestamp = process.env.MODEL_EOL_GENERATED
  const distributorNames = options.distributors ?? (options.distributor ? String(options.distributor).split(',') : [])
  const shouldRefreshProviders = !distributorNames.length || options.providerSpecified
  for (const name of options.providers) {
    generated.push(shouldRefreshProviders
      ? await generateProviderFeed(name, {
        fixtures: options.fixtures,
        generated: generatedTimestamp,
      })
      : generateCommittedFeed(name, { generated: generatedTimestamp }))
  }

  let distributorState
  if (distributorNames.length) {
    if (distributorNames.includes('aws-bedrock')) {
      generated.push(generateCommittedFeed('amazon', {
        generated: generatedTimestamp,
        provider: AMAZON_PROVIDER,
      }))
    }
    distributorState = { unconfirmedDistributions: [], noPublisherFeed: [] }
    for (const distributor of distributorNames) {
      const source = await loadDistributorSource(distributor, { fixtures: options.fixtures })
      const state = mergeDistributions(generated, {
        records: source.records,
        sourceUrl: source.sourceUrl,
        via: distributor,
      })
      for (const [index, item] of generated.entries()) item.feed = state.feeds[index]
      distributorState.unconfirmedDistributions.push(...state.unconfirmedDistributions)
      distributorState.noPublisherFeed.push(...state.noPublisherFeed)
    }
  }

  validateGeneratedFeeds(generated)

  const diffs = generated.map((item, index) => {
    const unconfirmedDistributions = distributorState?.unconfirmedDistributions
      .filter(distribution => distribution.publisher === item.provider.publisher) ?? []
    const noPublisherFeed = index === 0 ? distributorState?.noPublisherFeed ?? [] : []
    const diffOptions = {
      unconfirmed: item.unconfirmedIds,
      unconfirmedDistributions,
      noPublisherFeed,
      publisher: item.provider.publisher,
    }
    return {
      provider: item.provider,
      result: compareFeeds(item.committed, item.feed, diffOptions),
      markdown: renderSemanticDiff(item.committed, item.feed, diffOptions),
    }
  })
  const changed = diffs.some(item => item.result.changed)
  const markdown = combinedDiff(diffs)
  process.stdout.write(markdown)

  if (!options.check) writeGenerated(generated, options.out)
  return { changed, markdown, generated, diffs }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseRefreshArgs(argv)
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
    process.exitCode = error.exitCode ?? 1
  }
}
