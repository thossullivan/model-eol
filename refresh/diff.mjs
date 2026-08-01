// Semantic feed diffing for the refresh job. Feed metadata such as generated
// timestamps is intentionally excluded from the comparison.

const value = item => item === undefined || item === null || item === '' ? 'not set' : item

const code = item => `\`${String(value(item))}\``

const keysFor = model => [model.id, ...(model.aliases ?? [])].filter(Boolean)

function indexModels(feed) {
  const index = new Map()
  for (const model of feed.models ?? []) {
    for (const key of keysFor(model)) {
      if (!index.has(key)) index.set(key, model)
    }
  }
  return index
}

function findModel(index, model) {
  for (const key of keysFor(model)) {
    const found = index.get(key)
    if (found) return found
  }
  return undefined
}

function normaliseUnconfirmed(options, generated) {
  const supplied = options.unconfirmed ?? options.unconfirmedIds ?? []
  const ids = supplied instanceof Set ? [...supplied] : supplied
  const generatedIndex = indexModels(generated)
  const result = []
  const seen = new Set()
  for (const item of ids) {
    const id = typeof item === 'string' ? item : item?.id
    if (!id || seen.has(id)) continue
    const model = generatedIndex.get(id) ?? generated.models.find(candidate => candidate.id === id)
    if (!model) continue
    seen.add(model.id)
    result.push(model)
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

function distributionIndex(model) {
  const index = new Map()
  for (const distribution of model?.distributions ?? []) {
    if (!distribution?.via || index.has(distribution.via)) continue
    index.set(distribution.via, distribution)
  }
  return index
}

function normaliseUnconfirmedDistributions(options) {
  const supplied = options.unconfirmedDistributions ?? options.unconfirmedDistribution ?? []
  const values = supplied instanceof Set ? [...supplied] : supplied
  return values
    .filter(Boolean)
    .map(item => typeof item === 'string'
      ? { id: item, via: 'aws-bedrock' }
      : item)
    .sort((a, b) => `${a.publisher ?? ''}:${a.id ?? ''}`.localeCompare(`${b.publisher ?? ''}:${b.id ?? ''}`))
}

function normaliseNoPublisherFeed(options) {
  const supplied = options.noPublisherFeed ?? options.noPublisherFeeds ?? []
  const values = supplied instanceof Set ? [...supplied] : supplied
  return values
    .filter(Boolean)
    .map(item => typeof item === 'string' ? { bedrockId: item, normalizedId: item } : item)
    .sort((a, b) => String(a.bedrockId ?? '').localeCompare(String(b.bedrockId ?? '')))
}

function distributionChanges(oldModel, model, publisher) {
  const oldIndex = distributionIndex(oldModel)
  const nextIndex = distributionIndex(model)
  const vias = new Set([...oldIndex.keys(), ...nextIndex.keys()])
  const changes = []
  for (const via of vias) {
    const old = oldIndex.get(via)
    const next = nextIndex.get(via)
    if (!old && next) {
      changes.push({ publisher, id: model.id, via, kind: 'added', old, next })
      continue
    }
    if (old && !next) {
      changes.push({ publisher, id: model.id, via, kind: 'removed', old, next })
      continue
    }
    if (old.announced !== next.announced || old.shutdown !== next.shutdown) {
      changes.push({ publisher, id: model.id, via, kind: 'changed', old, next })
    }
  }
  return changes
}

/**
 * Compare a committed feed with a generated feed.
 *
 * The first argument is the old/committed feed and the second is the new feed.
 * `options.unconfirmed` may contain generated model IDs or generated model
 * objects retained because neither source confirmed them.
 */
export function compareFeeds(committed, generated, options = {}) {
  const oldIndex = indexModels(committed)
  const added = []
  const shutdownChanges = []
  const replacementChanges = []
  const newlyAnnounced = []
  const distributorChanges = []
  const publisher = options.publisher ?? generated.publisher

  for (const model of generated.models ?? []) {
    const old = findModel(oldIndex, model)
    if (!old) {
      added.push(model)
    } else {
      if (old.shutdown !== model.shutdown) {
        shutdownChanges.push({ id: model.id, old: old.shutdown, next: model.shutdown })
      }
      if (old.replacement !== model.replacement) {
        replacementChanges.push({ id: model.id, old: old.replacement, next: model.replacement })
      }
    }
    distributorChanges.push(...distributionChanges(old, model, publisher))
    if (model.announced && !old?.announced) newlyAnnounced.push(model)
  }

  const unconfirmed = normaliseUnconfirmed(options, generated)
  const sortById = (a, b) => a.id.localeCompare(b.id)
  added.sort(sortById)
  shutdownChanges.sort(sortById)
  replacementChanges.sort(sortById)
  newlyAnnounced.sort(sortById)
  distributorChanges.sort((a, b) => `${a.publisher}:${a.id}:${a.via}`.localeCompare(`${b.publisher}:${b.id}:${b.via}`))

  const unconfirmedDistributions = normaliseUnconfirmedDistributions(options)
  const noPublisherFeed = normaliseNoPublisherFeed(options)

  return {
    added,
    modelsAdded: added,
    shutdownChanges,
    shutdownDateChanges: shutdownChanges,
    replacementChanges,
    newlyAnnounced,
    newlyAnnouncedDeprecations: newlyAnnounced,
    unconfirmed,
    unconfirmedEntries: unconfirmed,
    distributionChanges: distributorChanges,
    distributionDateChanges: distributorChanges,
    unconfirmedDistributions,
    noPublisherFeed,
    noPublisherFeeds: noPublisherFeed,
    // Informational sections never alter the files, so they never trip exit 3.
    changed: Boolean(
      added.length ||
      shutdownChanges.length ||
      replacementChanges.length ||
      newlyAnnounced.length ||
      distributorChanges.length,
    ),
  }
}

const dateLine = model => `announced: ${code(model.announced)}; shutdown: ${code(model.shutdown)}`

function distributionDateLine(distribution) {
  return `announced: ${code(distribution?.announced)}; EOL: ${code(distribution?.shutdown)}`
}

function distributionModelLabel(change) {
  return change.publisher ? `${change.publisher}/${change.id}` : change.id
}

function renderDistributionChanges(result) {
  const lines = []
  for (const change of result.distributionChanges) {
    const label = code(distributionModelLabel(change))
    if (change.kind === 'added') {
      lines.push(`- ${label} - ${code(change.via)} dates added; ${distributionDateLine(change.next)}`)
    } else if (change.kind === 'removed') {
      lines.push(`- ${label} - ${code(change.via)} distribution removed`)
    } else {
      if (change.old.announced !== change.next.announced) {
        lines.push(`- ${label} - ${code(change.via)} legacy date moved ${code(change.old.announced)} -> ${code(change.next.announced)}`)
      }
      if (change.old.shutdown !== change.next.shutdown) {
        lines.push(`- ${label} - ${code(change.via)} EOL date moved ${code(change.old.shutdown)} -> ${code(change.next.shutdown)}`)
      }
    }
  }
  for (const item of result.unconfirmedDistributions) {
    const label = item.publisher ? `${item.publisher}/${item.id}` : item.id
    lines.push(`- ${code(label)} - ${code(item.via ?? 'aws-bedrock')} distribution unconfirmed; retained from committed feed`)
  }
  for (const item of result.noPublisherFeed) {
    lines.push(`- ${code(item.bedrockId)} - no publisher feed for normalized id ${code(item.normalizedId)}`)
  }
  return lines
}

function section(title, lines) {
  // Empty sections render as nothing, not "- None".
  if (!lines.length) return ''
  return [`## ${title}`, '', ...lines, ''].join('\n')
}

function renderResult(result, publisher) {
  const lines = ['# Feed refresh diff', '']
  if (publisher) lines.push(`Publisher: ${publisher}`, '')
  const pushSection = rendered => { if (rendered) lines.push(rendered) }

  pushSection(section(
    'Models added',
    result.added.filter(model => model.announced || model.shutdown)
      .map(model => `- ${code(model.id)} - ${dateLine(model)}; replacement: ${code(model.replacement)}`),
  ))
  const currentAdded = result.added.filter(model => !model.announced && !model.shutdown)
  pushSection(section(
    'Current models added - no retirement scheduled',
    currentAdded.map(model => `- ${code(model.id)}`),
  ))
  pushSection(section(
    'Shutdown date changes',
    result.shutdownChanges.map(change => `- ${code(change.id)} - ${code(change.old)} -> ${code(change.next)}`),
  ))
  pushSection(section(
    'Replacement changes',
    result.replacementChanges.map(change => `- ${code(change.id)} - ${code(change.old)} -> ${code(change.next)}`),
  ))
  pushSection(section(
    'Newly announced deprecations',
    result.newlyAnnounced.map(model => `- ${code(model.id)} - ${dateLine(model)}; replacement: ${code(model.replacement)}`),
  ))
  pushSection(section('Distribution changes', renderDistributionChanges(result)))
  pushSection(section(
    'Unconfirmed entries',
    result.unconfirmed.map(model => `- ${code(model.id)} - retained because neither source confirmed it`),
  ))

  if (!result.changed) lines.push('No semantic changes.', '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** Render a semantic diff, accepting either two feeds or a compareFeeds result. */
export function renderSemanticDiff(committed, generated, options = {}) {
  const result = committed?.added && committed?.shutdownChanges
    ? committed
    : generated?.added && generated?.shutdownChanges
      ? generated
      : compareFeeds(committed, generated, options)
  return renderResult(result, options.publisher ?? generated?.publisher)
}

export const semanticDiff = renderSemanticDiff
export const diffFeeds = compareFeeds
export const renderDiff = renderSemanticDiff
