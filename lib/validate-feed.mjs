export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const MAX_IDENTIFIER_LENGTH = 256
export const MAX_TEXT_LENGTH = 4096
export const MAX_URL_LENGTH = 4096
export const MAX_REPORT_BYTES = 8 * 1024 * 1024
export const MIN_TIMEOUT_MS = 1000
export const MAX_TIMEOUT_MS = 3600000

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const DATE_PRECISIONS = new Set(['exact', 'earliest', 'tentative'])
const DISTRIBUTION_STATUSES = new Set(['active', 'legacy', 'extended-access', 'retired'])
const RESERVED_DISTRIBUTION_VIAS = new Set(['publisher', 'publisher-fallback'])

export const assertIsoDate = (value, label = 'date') => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year >= 0 && year <= 99) date.setUTCFullYear(year)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) throw new Error(`${label} must be a real calendar date`)
  return value
}

const isObject = value => value && typeof value === 'object' && !Array.isArray(value)

const isUrl = value => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export const validateFeed = feed => {
  const errors = []
  const fail = (path, message) => errors.push({ path, message })
  const checkString = (value, path, limit = MAX_TEXT_LENGTH) => {
    if (typeof value !== 'string') return false
    if (CONTROL_CHARACTER_PATTERN.test(value)) fail(path, 'must not contain control characters')
    if (value.length > limit) fail(path, `must be at most ${limit} characters`)
    return true
  }
  const checkIdentifier = (value, path, required = false) => {
    if (value === undefined && !required) return false
    if (!checkString(value, path, MAX_IDENTIFIER_LENGTH)) {
      fail(path, required ? 'must be a string' : 'must be a string')
      return false
    }
    if (!value || !MODEL_ID_PATTERN.test(value)) fail(path, 'must be a grammar-valid model ID')
    return Boolean(value && MODEL_ID_PATTERN.test(value))
  }
  const checkUrl = (value, path) => {
    if (value === undefined) return false
    if (!checkString(value, path, MAX_URL_LENGTH)) {
      fail(path, 'must be a string URL')
      return false
    }
    if (!isUrl(value)) fail(path, 'must be an http or https URL')
    return true
  }
  const checkDate = (value, path) => {
    if (value === undefined) return false
    if (!checkString(value, path, 32)) {
      fail(path, 'must be YYYY-MM-DD')
      return false
    }
    try {
      assertIsoDate(value, path)
      return true
    } catch (error) {
      fail(path, error.message)
      return false
    }
  }
  const checkDateTime = (value, path) => {
    if (!checkString(value, path, 64)) {
      fail(path, 'must be an ISO date-time')
      return false
    }
    if (!DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
      fail(path, 'must be an ISO date-time')
      return false
    }
    try {
      assertIsoDate(value.slice(0, 10), path)
    } catch (error) {
      fail(path, error.message)
      return false
    }
    return true
  }
  const checkObjectKeys = (value, path, allowed) => {
    if (!isObject(value)) {
      fail(path, 'must be an object')
      return false
    }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field')
    }
    return true
  }
  const walkStrings = (value, path, seen = new Set()) => {
    if (typeof value === 'string') {
      checkString(value, path)
      return
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, seen))
    } else {
      for (const [key, item] of Object.entries(value)) walkStrings(item, `${path}.${key}`, seen)
    }
  }

  walkStrings(feed, 'feed')
  if (!isObject(feed)) {
    fail('feed', 'must be a JSON object')
    return errors
  }
  checkObjectKeys(feed, 'feed', new Set(['spec', 'publisher', 'generated', 'source', 'note', 'policy', 'models']))
  if (feed.spec !== 'model-eol/0.1') fail('spec', `must be model-eol/0.1, got ${feed.spec}`)
  if (!checkString(feed.publisher, 'publisher', MAX_IDENTIFIER_LENGTH) || !feed.publisher) fail('publisher', 'must be a non-empty string')
  checkDateTime(feed.generated, 'generated')
  checkUrl(feed.source, 'source')
  if (feed.note !== undefined) checkString(feed.note, 'note', MAX_TEXT_LENGTH)
  if (!Array.isArray(feed.models)) {
    fail('models', 'must be an array')
    return errors
  }

  if (feed.policy !== undefined && checkObjectKeys(feed.policy, 'policy', new Set(['min_notice_days', 'source']))) {
    if (!Number.isSafeInteger(feed.policy.min_notice_days) || feed.policy.min_notice_days < 0) {
      fail('policy.min_notice_days', 'must be a non-negative safe integer')
    }
    if (feed.policy.source === undefined) fail('policy.source', 'is required')
    else checkUrl(feed.policy.source, 'policy.source')
  }

  const modelKeys = new Set()
  const seenKeys = new Map()
  const validDates = []
  for (const [index, model] of feed.models.entries()) {
    const at = `models[${index}]`
    if (!checkObjectKeys(model, at, new Set([
      'id', 'aliases', 'announced', 'shutdown', 'date_precision', 'replacement',
      'replacement_options', 'replacement_note', 'notes', 'source', 'distributions',
    ]))) continue

    const idValid = checkIdentifier(model.id, `${at}.id`, true)
    if (idValid) {
      modelKeys.add(model.id)
      const previous = seenKeys.get(model.id)
      if (previous) fail(`${at}.id`, `duplicate id/alias "${model.id}" also used at ${previous}`)
      else seenKeys.set(model.id, `${at}.id`)
    }

    if (model.aliases !== undefined) {
      if (!Array.isArray(model.aliases) || model.aliases.length === 0) {
        fail(`${at}.aliases`, 'must be a non-empty array')
      } else {
        for (const [aliasIndex, alias] of model.aliases.entries()) {
          const aliasPath = `${at}.aliases[${aliasIndex}]`
          if (!checkIdentifier(alias, aliasPath, true)) continue
          modelKeys.add(alias)
          const previous = seenKeys.get(alias)
          if (previous) fail(aliasPath, `duplicate id/alias "${alias}" also used at ${previous}`)
          else seenKeys.set(alias, aliasPath)
        }
      }
    }

    const announcedValid = checkDate(model.announced, `${at}.announced`)
    const shutdownValid = checkDate(model.shutdown, `${at}.shutdown`)
    if (announcedValid && shutdownValid) validDates.push({ at, announced: model.announced, shutdown: model.shutdown })
    if (model.date_precision !== undefined) {
      if (typeof model.date_precision !== 'string' || !DATE_PRECISIONS.has(model.date_precision)) fail(`${at}.date_precision`, 'must be exact, earliest, or tentative')
    }
    if (model.date_precision === 'tentative' && model.announced !== undefined) {
      fail(`${at}.announced`, 'must be absent when date_precision is tentative')
    }
    if (model.replacement !== undefined) checkIdentifier(model.replacement, `${at}.replacement`)
    if (model.replacement_options !== undefined) {
      if (!Array.isArray(model.replacement_options) || model.replacement_options.length === 0) {
        fail(`${at}.replacement_options`, 'must be a non-empty array')
      } else {
        for (const [optionIndex, option] of model.replacement_options.entries()) {
          checkIdentifier(option, `${at}.replacement_options[${optionIndex}]`, true)
        }
      }
      if (model.replacement !== undefined) fail(at, 'replacement and replacement_options are mutually exclusive')
    }
    if (model.replacement_note !== undefined) checkString(model.replacement_note, `${at}.replacement_note`, MAX_TEXT_LENGTH)
    if (model.notes !== undefined) checkString(model.notes, `${at}.notes`, MAX_TEXT_LENGTH)
    checkUrl(model.source, `${at}.source`)
    if (model.announced || model.shutdown) {
      if (!(model.source || feed.source)) fail(at, 'dated entry needs a source (entry- or feed-level)')
    }
    if (model.distributions !== undefined) {
      if (!Array.isArray(model.distributions)) {
        fail(`${at}.distributions`, 'must be an array')
      } else {
        const seenDistributionVias = new Map()
        for (const [distributionIndex, distribution] of model.distributions.entries()) {
          const dAt = `${at}.distributions[${distributionIndex}]`
          if (!checkObjectKeys(distribution, dAt, new Set(['via', 'announced', 'shutdown', 'date_precision', 'status', 'source']))) continue
          if (!checkString(distribution.via, `${dAt}.via`, MAX_IDENTIFIER_LENGTH) || !distribution.via) fail(`${dAt}.via`, 'must be a non-empty string')
          if (typeof distribution.via === 'string' && distribution.via.length > 0) {
            if (RESERVED_DISTRIBUTION_VIAS.has(distribution.via.toLowerCase())) {
              fail(`${dAt}.via`, 'must not use a reserved publisher clock name')
            }
            const previous = seenDistributionVias.get(distribution.via)
            if (previous) fail(`${dAt}.via`, `duplicate distributor via "${distribution.via}" also used at ${previous}`)
            else seenDistributionVias.set(distribution.via, `${dAt}.via`)
          }
          const distributionAnnounced = checkDate(distribution.announced, `${dAt}.announced`)
          const distributionShutdown = checkDate(distribution.shutdown, `${dAt}.shutdown`)
          if (distributionAnnounced && distributionShutdown && distribution.shutdown < distribution.announced) fail(dAt, 'shutdown precedes announced')
          if (distribution.date_precision !== undefined && (typeof distribution.date_precision !== 'string' || !DATE_PRECISIONS.has(distribution.date_precision))) fail(`${dAt}.date_precision`, 'must be exact, earliest, or tentative')
          if (distribution.status !== undefined && (typeof distribution.status !== 'string' || !DISTRIBUTION_STATUSES.has(distribution.status))) fail(`${dAt}.status`, 'has an unsupported status')
          if (distribution.date_precision === 'tentative' && distribution.announced !== undefined) {
            fail(`${dAt}.announced`, 'must be absent when date_precision is tentative')
          }
          if (distribution.date_precision === 'tentative' && distribution.status === 'retired') {
            fail(`${dAt}.status`, 'must not be retired when date_precision is tentative')
          }
          checkUrl(distribution.source, `${dAt}.source`)
          if ((distribution.announced || distribution.shutdown) && !(distribution.source || model.source || feed.source)) fail(dAt, 'dated distribution needs a source')
        }
      }
    }
  }

  for (const date of validDates) {
    if (date.shutdown < date.announced) fail(date.at, 'shutdown precedes announced')
  }
  for (const [index, model] of feed.models.entries()) {
    if (!isObject(model) || typeof model.replacement !== 'string' || !MODEL_ID_PATTERN.test(model.replacement)) continue
    if (!modelKeys.has(model.replacement)) fail(`models[${index}].replacement`, `does not resolve to an id or alias in this feed: ${model.replacement}`)
  }
  return errors
}

export const assertValidFeed = (feed, label = 'feed') => {
  const errors = validateFeed(feed)
  if (errors.length) {
    const models = Array.isArray(feed?.models) ? feed.models : []
    const lines = errors.map(error => {
      const modelIndex = error.path.match(/^models\[(\d+)\]/)?.[1]
      const modelId = modelIndex !== undefined ? models[Number(modelIndex)]?.id : models.find(model => model?.id)?.id
      const context = typeof modelId === 'string' ? ` model ${modelId}` : ''
      return `${label}${context}: ${error.path}: ${error.message}`
    })
    throw new Error(lines.join('\n'))
  }
  return feed
}
