import fs from 'node:fs'
import { TextDecoder } from 'node:util'

import { matchesAnyGlob, normalizeRepoPath } from './glob.mjs'
import { MAX_REPORT_BYTES, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from './validate-feed.mjs'

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const frozenArray = () => Object.freeze([])

export const DEFAULT_CONFIG = Object.freeze({
  days: 90,
  scope: 'direct',
  via: null,
  feeds: Object.freeze({ allow_vendored_fallback: false }),
  ignore: Object.freeze({ models: frozenArray(), paths: frozenArray() }),
  overrides: frozenArray(),
  routes: frozenArray(),
  issues: Object.freeze({ enabled: true }),
  eval: Object.freeze({ command: null, timeout_ms: 600000, max_report_bytes: 65536, pass_env: frozenArray() }),
})

export const CLI_DEFAULT_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  scope: 'all',
})

const copyDefaults = defaults => ({
  days: defaults.days,
  scope: defaults.scope,
  via: defaults.via,
  feeds: { allow_vendored_fallback: defaults.feeds.allow_vendored_fallback },
  ignore: {
    models: [...defaults.ignore.models],
    paths: [...defaults.ignore.paths],
  },
  overrides: (defaults.overrides ?? []).map(override => ({
    ...override,
    paths: [...override.paths],
    ...(override.ignore ? { ignore: {
      models: [...(override.ignore.models ?? [])],
      paths: [...(override.ignore.paths ?? [])],
    } } : {}),
  })),
  routes: (defaults.routes ?? []).map(route => ({ ...route, paths: [...route.paths] })),
  issues: { enabled: defaults.issues.enabled },
  eval: {
    command: defaults.eval.command,
    timeout_ms: defaults.eval.timeout_ms,
    max_report_bytes: defaults.eval.max_report_bytes,
    pass_env: [...defaults.eval.pass_env],
  },
})

const assert = (condition, message) => {
  if (!condition) throw new Error(`invalid .model-eol.json: ${message}`)
}

const assertKnownKeys = (value, label, allowed) => {
  for (const key of Object.keys(value)) {
    const fullKey = label ? `${label}.${key}` : key
    assert(allowed.has(key), `unknown key "${fullKey}"`)
  }
}

const stringArray = (value, label) => {
  assert(Array.isArray(value), `${label} must be an array`)
  assert(value.every(item => typeof item === 'string' && item.length > 0), `${label} must contain non-empty strings`)
  return value.slice()
}

const nonEmptyString = (value, label) => {
  assert(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`)
  return value
}

const normalizeIgnore = (raw, label) => {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), `${label} must be an object`)
  assertKnownKeys(raw, label, new Set(['models', 'paths']))
  return {
    models: raw.models === undefined ? [] : stringArray(raw.models, `${label}.models`),
    paths: raw.paths === undefined ? [] : stringArray(raw.paths, `${label}.paths`),
  }
}

const normalizeOverride = (raw, index) => {
  const label = `overrides[${index}]`
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), `${label} must be an object`)
  assertKnownKeys(raw, label, new Set(['paths', 'days', 'scope', 'via', 'ignore']))
  const override = { paths: stringArray(raw.paths, `${label}.paths`) }
  assert(override.paths.length > 0, `${label}.paths must not be empty`)
  if (raw.days !== undefined) {
    assert(Number.isInteger(raw.days) && raw.days >= 0, `${label}.days must be a non-negative integer`)
    override.days = raw.days
  }
  if (raw.scope !== undefined) {
    assert(raw.scope === 'all' || raw.scope === 'direct', `${label}.scope must be all or direct`)
    override.scope = raw.scope
  }
  if (raw.via !== undefined) {
    assert(raw.via === null || (typeof raw.via === 'string' && raw.via.length > 0), `${label}.via must be null or a non-empty string`)
    override.via = raw.via
  }
  if (raw.ignore !== undefined) override.ignore = normalizeIgnore(raw.ignore, `${label}.ignore`)
  return override
}

const normalizeRoute = (raw, index) => {
  const label = `routes[${index}]`
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), `${label} must be an object`)
  assertKnownKeys(raw, label, new Set(['paths', 'via', 'match', 'model']))
  const route = {
    paths: stringArray(raw.paths, `${label}.paths`),
    via: nonEmptyString(raw.via, `${label}.via`),
  }
  assert(route.paths.length > 0, `${label}.paths must not be empty`)
  assert((raw.match === undefined) === (raw.model === undefined), `${label}.match and ${label}.model must be provided together`)
  if (raw.match !== undefined) {
    route.match = nonEmptyString(raw.match, `${label}.match`)
    route.model = nonEmptyString(raw.model, `${label}.model`)
  }
  return route
}

const CREDENTIAL_ENV_PATTERN = /^(?:GITHUB_|GH_|ACTIONS_|SSH_|AWS_SECRET)|(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

export const normalizeConfig = (raw, { defaults = DEFAULT_CONFIG } = {}) => {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'root must be an object')
  assertKnownKeys(raw, '', new Set(['days', 'scope', 'via', 'feeds', 'ignore', 'overrides', 'routes', 'issues', 'eval']))
  const config = copyDefaults(defaults)

  if (raw.days !== undefined) {
    assert(Number.isInteger(raw.days) && raw.days >= 0, 'days must be a non-negative integer')
    config.days = raw.days
  }
  if (raw.scope !== undefined) {
    assert(raw.scope === 'all' || raw.scope === 'direct', 'scope must be all or direct')
    config.scope = raw.scope
  }
  if (raw.via !== undefined) {
    assert(raw.via === null || (typeof raw.via === 'string' && raw.via.length > 0), 'via must be null or a non-empty string')
    config.via = raw.via
  }
  if (raw.feeds !== undefined) {
    assert(raw.feeds && typeof raw.feeds === 'object' && !Array.isArray(raw.feeds), 'feeds must be an object')
    assertKnownKeys(raw.feeds, 'feeds', new Set(['allow_vendored_fallback']))
    if (raw.feeds.allow_vendored_fallback !== undefined) {
      assert(typeof raw.feeds.allow_vendored_fallback === 'boolean', 'feeds.allow_vendored_fallback must be boolean')
      config.feeds.allow_vendored_fallback = raw.feeds.allow_vendored_fallback
    }
  }
  if (raw.ignore !== undefined) {
    const ignore = normalizeIgnore(raw.ignore, 'ignore')
    if (raw.ignore.models !== undefined) config.ignore.models = ignore.models
    if (raw.ignore.paths !== undefined) config.ignore.paths = ignore.paths
  }
  if (raw.overrides !== undefined) {
    assert(Array.isArray(raw.overrides), 'overrides must be an array')
    config.overrides = raw.overrides.map(normalizeOverride)
  }
  if (raw.routes !== undefined) {
    assert(Array.isArray(raw.routes), 'routes must be an array')
    config.routes = raw.routes.map(normalizeRoute)
  }
  if (raw.issues !== undefined) {
    assert(raw.issues && typeof raw.issues === 'object' && !Array.isArray(raw.issues), 'issues must be an object')
    assertKnownKeys(raw.issues, 'issues', new Set(['enabled']))
    if (raw.issues.enabled !== undefined) assert(typeof raw.issues.enabled === 'boolean', 'issues.enabled must be boolean')
    if (raw.issues.enabled !== undefined) config.issues.enabled = raw.issues.enabled
  }
  if (raw.eval !== undefined) {
    assert(raw.eval && typeof raw.eval === 'object' && !Array.isArray(raw.eval), 'eval must be an object')
    assertKnownKeys(raw.eval, 'eval', new Set(['command', 'timeout_ms', 'max_report_bytes', 'pass_env']))
    if (raw.eval.command !== undefined) {
      assert(raw.eval.command === null || (typeof raw.eval.command === 'string' && raw.eval.command.length > 0), 'eval.command must be null or a non-empty string')
      config.eval.command = raw.eval.command
    }
    if (raw.eval.timeout_ms !== undefined) {
      assert(Number.isSafeInteger(raw.eval.timeout_ms) && raw.eval.timeout_ms >= MIN_TIMEOUT_MS && raw.eval.timeout_ms <= MAX_TIMEOUT_MS, `eval.timeout_ms must be a safe integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
      config.eval.timeout_ms = raw.eval.timeout_ms
    }
    if (raw.eval.max_report_bytes !== undefined) {
      assert(Number.isSafeInteger(raw.eval.max_report_bytes) && raw.eval.max_report_bytes > 0 && raw.eval.max_report_bytes <= MAX_REPORT_BYTES, `eval.max_report_bytes must be a safe positive integer <= ${MAX_REPORT_BYTES}`)
      config.eval.max_report_bytes = raw.eval.max_report_bytes
    }
    if (raw.eval.pass_env !== undefined) {
      const passEnv = stringArray(raw.eval.pass_env, 'eval.pass_env')
      for (const name of passEnv) assert(!CREDENTIAL_ENV_PATTERN.test(name), `eval.pass_env variable "${name}" is not allowed`)
      config.eval.pass_env = passEnv
    }
  }

  return config
}

export const configForRepoPath = (config, repoPath) => {
  const normalizedPath = normalizeRepoPath(repoPath)
  const policy = {
    days: config.days,
    scope: config.scope,
    via: config.via,
    ignore: {
      models: [...config.ignore.models],
      paths: [...config.ignore.paths],
    },
    override_indexes: [],
  }
  for (const [index, override] of (config.overrides ?? []).entries()) {
    if (!matchesAnyGlob(normalizedPath, override.paths)) continue
    policy.override_indexes.push(index)
    if (override.days !== undefined) policy.days = override.days
    if (override.scope !== undefined) policy.scope = override.scope
    if (override.via !== undefined) policy.via = override.via
    if (override.ignore) {
      policy.ignore.models.push(...override.ignore.models)
      policy.ignore.paths.push(...override.ignore.paths)
    }
  }
  policy.ignore.models = [...new Set(policy.ignore.models)]
  policy.ignore.paths = [...new Set(policy.ignore.paths)]
  return policy
}

export const routeForRepoReference = (config, repoPath, { matched = null, id = null } = {}) => {
  const normalizedPath = normalizeRepoPath(repoPath)
  let selected = null
  for (const [index, route] of (config.routes ?? []).entries()) {
    if (!matchesAnyGlob(normalizedPath, route.paths)) continue
    if (route.match !== undefined && route.match !== matched && route.match !== id) continue
    selected = { ...route, index }
  }
  return selected
}

export const mappedRoutesForRepoPath = (config, repoPath) => {
  const normalizedPath = normalizeRepoPath(repoPath)
  return (config.routes ?? []).flatMap((route, index) =>
    route.match !== undefined && route.model !== undefined && matchesAnyGlob(normalizedPath, route.paths)
      ? [{ ...route, index }]
      : [])
}

export const configuredVias = config => [
  config.via,
  ...(config.overrides ?? []).map(override => override.via),
  ...(config.routes ?? []).map(route => route.via),
].filter(via => typeof via === 'string' && via.length > 0)

export const loadConfig = (file, { defaults = DEFAULT_CONFIG, allowMissing = true } = {}) => {
  if (!fs.existsSync(file)) {
    if (allowMissing) return normalizeConfig({}, { defaults })
    throw new Error(`could not read config ${file}: file not found`)
  }
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch (error) {
    throw new Error(`could not read config ${file}: ${error.message}`)
  }
  let source
  try {
    source = utf8Decoder.decode(bytes)
  } catch {
    throw new Error(`could not read config ${file}: invalid UTF-8`)
  }
  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`could not read config ${file}: ${error.message}`)
  }
  return normalizeConfig(value, { defaults })
}
