import fs from 'node:fs'

export const DEFAULT_CONFIG = Object.freeze({
  days: 90,
  scope: 'direct',
  via: null,
  ignore: Object.freeze({ models: Object.freeze([]), paths: Object.freeze([]) }),
  issues: Object.freeze({ enabled: true }),
  eval: Object.freeze({ command: null, timeout_ms: 600000, max_report_bytes: 65536, pass_env: Object.freeze([]) }),
})

const copyDefaults = () => ({
  days: DEFAULT_CONFIG.days,
  scope: DEFAULT_CONFIG.scope,
  via: DEFAULT_CONFIG.via,
  ignore: { models: [], paths: [] },
  issues: { enabled: DEFAULT_CONFIG.issues.enabled },
  eval: {
    command: DEFAULT_CONFIG.eval.command,
    timeout_ms: DEFAULT_CONFIG.eval.timeout_ms,
    max_report_bytes: DEFAULT_CONFIG.eval.max_report_bytes,
    pass_env: [],
  },
})

const assert = (condition, message) => {
  if (!condition) throw new Error(`invalid .model-eol.json: ${message}`)
}

const stringArray = (value, label) => {
  assert(Array.isArray(value), `${label} must be an array`)
  assert(value.every(item => typeof item === 'string' && item.length > 0), `${label} must contain non-empty strings`)
  return value.slice()
}

export const normalizeConfig = raw => {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'root must be an object')
  const config = copyDefaults()

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
  if (raw.ignore !== undefined) {
    assert(raw.ignore && typeof raw.ignore === 'object' && !Array.isArray(raw.ignore), 'ignore must be an object')
    if (raw.ignore.models !== undefined) config.ignore.models = stringArray(raw.ignore.models, 'ignore.models')
    if (raw.ignore.paths !== undefined) config.ignore.paths = stringArray(raw.ignore.paths, 'ignore.paths')
  }
  if (raw.issues !== undefined) {
    assert(raw.issues && typeof raw.issues === 'object' && !Array.isArray(raw.issues), 'issues must be an object')
    if (raw.issues.enabled !== undefined) assert(typeof raw.issues.enabled === 'boolean', 'issues.enabled must be boolean')
    if (raw.issues.enabled !== undefined) config.issues.enabled = raw.issues.enabled
  }
  if (raw.eval !== undefined) {
    assert(raw.eval && typeof raw.eval === 'object' && !Array.isArray(raw.eval), 'eval must be an object')
    if (raw.eval.command !== undefined) {
      assert(raw.eval.command === null || (typeof raw.eval.command === 'string' && raw.eval.command.length > 0), 'eval.command must be null or a non-empty string')
      config.eval.command = raw.eval.command
    }
    if (raw.eval.timeout_ms !== undefined) {
      assert(Number.isInteger(raw.eval.timeout_ms) && raw.eval.timeout_ms > 0, 'eval.timeout_ms must be a positive integer')
      config.eval.timeout_ms = raw.eval.timeout_ms
    }
    if (raw.eval.max_report_bytes !== undefined) {
      assert(Number.isInteger(raw.eval.max_report_bytes) && raw.eval.max_report_bytes >= 0, 'eval.max_report_bytes must be a non-negative integer')
      config.eval.max_report_bytes = raw.eval.max_report_bytes
    }
    if (raw.eval.pass_env !== undefined) config.eval.pass_env = stringArray(raw.eval.pass_env, 'eval.pass_env')
  }

  return config
}

export const loadConfig = file => {
  if (!fs.existsSync(file)) return copyDefaults()
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`could not read config ${file}: ${error.message}`)
  }
  return normalizeConfig(value)
}
