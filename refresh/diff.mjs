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
    if (model.announced && !old?.announced) newlyAnnounced.push(model)
  }

  const unconfirmed = normaliseUnconfirmed(options, generated)
  const sortById = (a, b) => a.id.localeCompare(b.id)
  added.sort(sortById)
  shutdownChanges.sort(sortById)
  replacementChanges.sort(sortById)
  newlyAnnounced.sort(sortById)

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
    changed: Boolean(
      added.length ||
      shutdownChanges.length ||
      replacementChanges.length ||
      newlyAnnounced.length ||
      unconfirmed.length,
    ),
  }
}

const dateLine = model => `announced: ${code(model.announced)}; shutdown: ${code(model.shutdown)}`

function section(title, lines) {
  return [`## ${title}`, '', ...(lines.length ? lines : ['- None']), ''].join('\n')
}

function renderResult(result, publisher) {
  const lines = ['# Feed refresh diff', '']
  if (publisher) lines.push(`Publisher: ${publisher}`, '')

  lines.push(section(
    'Models added',
    result.added.map(model => `- ${code(model.id)} - ${dateLine(model)}; replacement: ${code(model.replacement)}`),
  ))
  lines.push(section(
    'Shutdown date changes',
    result.shutdownChanges.map(change => `- ${code(change.id)} - ${code(change.old)} -> ${code(change.next)}`),
  ))
  lines.push(section(
    'Replacement changes',
    result.replacementChanges.map(change => `- ${code(change.id)} - ${code(change.old)} -> ${code(change.next)}`),
  ))
  lines.push(section(
    'Newly announced deprecations',
    result.newlyAnnounced.map(model => `- ${code(model.id)} - ${dateLine(model)}; replacement: ${code(model.replacement)}`),
  ))
  lines.push(section(
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
