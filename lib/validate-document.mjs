import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import { normalizeConfig } from './config.mjs'
import { JsonSchemaRegistry, validateJsonSchema } from './json-schema.mjs'
import { validateFeed } from './validate-feed.mjs'

export const DOCUMENT_TYPES = Object.freeze(['feed', 'config', 'check', 'inventory', 'schedule', 'alert', 'plan'])

const SCHEMA_FILES = Object.freeze({
  feed: 'model-eol.schema.json',
  config: 'model-eol.bot-config.schema.json',
  check: 'model-eol.check.schema.json',
  inventory: 'model-eol.inventory.schema.json',
  schedule: 'model-eol.schedule.schema.json',
  alert: 'model-eol.alert.schema.json',
  plan: 'model-eol.plan.schema.json',
})

const TYPE_ALIASES = new Map([
  ['bot-config', 'config'],
  ['model-eol-config', 'config'],
])

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const SCHEMA_DISCRIMINATORS = new Map([
  ['model-eol/check@0.1', 'check'],
  ['model-eol/inventory@0.1', 'inventory'],
  ['model-eol/schedule@0.1', 'schedule'],
  ['model-eol/alert@0.1', 'alert'],
])

let catalogCache

export const loadDocumentSchemaCatalog = () => {
  if (catalogCache) return catalogCache
  const directory = new URL('../schema/', import.meta.url)
  const byType = new Map()
  for (const type of DOCUMENT_TYPES) {
    const file = new URL(SCHEMA_FILES[type], directory)
    let schema
    try {
      schema = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`failed to load ${type} schema: ${error.message}`)
    }
    byType.set(type, schema)
  }
  const registry = new JsonSchemaRegistry([...byType.values()])
  registry.assertReferences()
  const byId = new Map([...byType.entries()].map(([type, schema]) => [schema.$id, { type, schema }]))
  catalogCache = { byType, byId, registry }
  return catalogCache
}

export const normalizeDocumentType = value => {
  if (typeof value !== 'string' || !value) return null
  const normalized = TYPE_ALIASES.get(value) ?? value
  return DOCUMENT_TYPES.includes(normalized) ? normalized : null
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const configKeys = new Set([
  'days', 'scope', 'via', 'feeds', 'ignore', 'waivers', 'overrides', 'routes', 'issues', 'eval',
])

export const detectDocumentType = (document, { file = null } = {}) => {
  if (!isObject(document)) return null
  if (typeof document.$schema === 'string' && typeof document.$id === 'string') return 'schema'
  if (Object.hasOwn(document, 'spec')) return 'feed'
  if (Object.hasOwn(document, 'plan_schema')) return 'plan'
  if (typeof document.schema === 'string') return SCHEMA_DISCRIMINATORS.get(document.schema) ?? null
  if (file && path.basename(file) === '.model-eol.json') return 'config'
  const keys = Object.keys(document)
  if (keys.length && keys.every(key => configKeys.has(key))) return 'config'
  return null
}

const schemaDefinitionErrors = (document, catalog) => {
  const errors = []
  const fail = (path, keyword, message) => errors.push({ path, keyword, message })
  if (!isObject(document)) return [{ path: '$', keyword: 'type', message: 'must be an object' }]
  if (document.$schema !== 'http://json-schema.org/draft-07/schema#') {
    fail('$.$schema', '$schema', 'must equal "http://json-schema.org/draft-07/schema#"')
  }
  const registered = catalog.byId.get(document.$id)
  if (!registered) fail('$.$id', '$id', `must identify one of the ${catalog.byType.size} published model-eol schemas`)

  const validTypes = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'])
  const validFormats = new Set(['date', 'date-time', 'uri'])
  const supportedKeywords = new Set([
    '$schema', '$id', '$ref', '$comment',
    'title', 'description', 'default', 'examples', 'readOnly', 'writeOnly',
    'type', 'const', 'enum', 'format', 'pattern',
    'minLength', 'maxLength', 'minimum', 'maximum',
    'minItems', 'maxItems', 'uniqueItems', 'items',
    'required', 'properties', 'additionalProperties', 'dependencies',
    'definitions', 'allOf', 'oneOf',
  ])
  const childPath = (base, key) => `${base}.${key}`
  const lint = (rule, at) => {
    if (typeof rule === 'boolean') return
    if (!isObject(rule)) {
      fail(at, 'schema', 'must be an object or boolean schema')
      return
    }
    for (const keyword of Object.keys(rule)) {
      if (!supportedKeywords.has(keyword)) {
        fail(childPath(at, keyword), keyword, `unsupported JSON Schema keyword ${keyword}`)
      }
    }
    if (rule.$ref !== undefined && typeof rule.$ref !== 'string') fail(childPath(at, '$ref'), '$ref', 'must be a string')
    if (rule.type !== undefined) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type]
      if (!types.length || types.some(type => typeof type !== 'string' || !validTypes.has(type))) {
        fail(childPath(at, 'type'), 'type', 'must name one or more JSON types')
      }
    }
    if (rule.required !== undefined && (!Array.isArray(rule.required) || rule.required.some(value => typeof value !== 'string'))) {
      fail(childPath(at, 'required'), 'required', 'must be an array of property names')
    }
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || rule.enum.length === 0)) {
      fail(childPath(at, 'enum'), 'enum', 'must be a non-empty array')
    }
    if (rule.format !== undefined && (typeof rule.format !== 'string' || !validFormats.has(rule.format))) {
      fail(childPath(at, 'format'), 'format', 'must be date, date-time, or uri')
    }
    if (rule.pattern !== undefined) {
      if (typeof rule.pattern !== 'string') fail(childPath(at, 'pattern'), 'pattern', 'must be a string')
      else {
        try {
          new RegExp(rule.pattern)
        } catch {
          fail(childPath(at, 'pattern'), 'pattern', 'must be a valid regular expression')
        }
      }
    }
    for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (rule[keyword] !== undefined && (!Number.isInteger(rule[keyword]) || rule[keyword] < 0)) {
        fail(childPath(at, keyword), keyword, 'must be a non-negative integer')
      }
    }
    if (rule.uniqueItems !== undefined && typeof rule.uniqueItems !== 'boolean') {
      fail(childPath(at, 'uniqueItems'), 'uniqueItems', 'must be a boolean')
    }
    for (const keyword of ['minimum', 'maximum']) {
      if (rule[keyword] !== undefined && (typeof rule[keyword] !== 'number' || !Number.isFinite(rule[keyword]))) {
        fail(childPath(at, keyword), keyword, 'must be a finite number')
      }
    }
    for (const keyword of ['properties', 'definitions']) {
      if (rule[keyword] === undefined) continue
      if (!isObject(rule[keyword])) {
        fail(childPath(at, keyword), keyword, 'must be an object of schemas')
        continue
      }
      for (const [name, child] of Object.entries(rule[keyword])) lint(child, `${at}.${keyword}[${JSON.stringify(name)}]`)
    }
    if (rule.items !== undefined) lint(rule.items, childPath(at, 'items'))
    if (rule.additionalProperties !== undefined) lint(rule.additionalProperties, childPath(at, 'additionalProperties'))
    for (const keyword of ['allOf', 'oneOf']) {
      if (rule[keyword] === undefined) continue
      if (!Array.isArray(rule[keyword]) || rule[keyword].length === 0) {
        fail(childPath(at, keyword), keyword, 'must be a non-empty array of schemas')
        continue
      }
      rule[keyword].forEach((child, index) => lint(child, `${at}.${keyword}[${index}]`))
    }
    if (rule.dependencies !== undefined) {
      if (!isObject(rule.dependencies)) fail(childPath(at, 'dependencies'), 'dependencies', 'must be an object')
      else {
        for (const [name, dependency] of Object.entries(rule.dependencies)) {
          const dependencyPath = `${at}.dependencies[${JSON.stringify(name)}]`
          if (Array.isArray(dependency)) {
            if (dependency.some(value => typeof value !== 'string')) fail(dependencyPath, 'dependencies', 'must contain property names')
          } else lint(dependency, dependencyPath)
        }
      }
    }
  }
  lint(document, '$')

  if (registered) {
    try {
      const companionSchemas = [...catalog.byType.values()].filter(schema => schema.$id !== document.$id)
      const registry = new JsonSchemaRegistry([document, ...companionSchemas])
      registry.assertReferences()
    } catch (error) {
      fail('$', '$ref', error.message)
    }
  }
  return errors
}

const semanticErrors = (document, type) => {
  if (type === 'feed') {
    return validateFeed(document).map(error => ({
      path: error.path === 'feed' ? '$' : `$.${error.path}`,
      keyword: 'model-eol-feed',
      message: error.message,
    }))
  }
  if (type === 'config') {
    try {
      normalizeConfig(document)
      return []
    } catch (error) {
      return [{ path: '$', keyword: 'model-eol-config', message: error.message }]
    }
  }
  if (type === 'plan') {
    try {
      validatePlanItems(document.items)
      return []
    } catch (error) {
      return [{ path: '$.items', keyword: 'model-eol-plan', message: error.message }]
    }
  }
  return []
}

export const validateDocument = (document, { type, file = null } = {}) => {
  const selectedType = type === undefined || type === null
    ? detectDocumentType(document, { file })
    : normalizeDocumentType(type)
  if (!selectedType) {
    const detail = type
      ? `unknown document type ${JSON.stringify(type)}`
      : typeof document?.schema === 'string'
        ? `unknown document schema ${JSON.stringify(document.schema)}`
        : 'could not determine the document type'
    return {
      type: null,
      errors: [{ path: '$', keyword: 'documentType', message: `${detail}; use --type ${DOCUMENT_TYPES.join('|')}` }],
    }
  }

  const catalog = loadDocumentSchemaCatalog()
  if (selectedType === 'schema') return { type: selectedType, errors: schemaDefinitionErrors(document, catalog) }
  const { byType, registry } = catalog
  const schemaErrors = validateJsonSchema(document, byType.get(selectedType), { registry })
  return {
    type: selectedType,
    errors: schemaErrors.length ? schemaErrors : semanticErrors(document, selectedType),
  }
}

export const formatDocumentErrors = errors => errors.map(error => `${error.path}: ${error.message}`)

export const assertValidDocument = (document, options = {}) => {
  const result = validateDocument(document, options)
  if (result.errors.length) throw new Error(formatDocumentErrors(result.errors).join('\n'))
  return { document, type: result.type }
}

export const validatePlanItems = items => {
  if (!Array.isArray(items)) throw new Error('plan must contain an items array')
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`plan item ${index} must be an object`)
    }
    if (typeof item.file !== 'string' || item.file.length === 0) {
      throw new Error(`plan item ${index} file must be a non-empty string`)
    }
    if (!Number.isInteger(item.line) || item.line < 1) {
      throw new Error(`plan item ${index} line must be an integer >= 1`)
    }
    if (!Number.isInteger(item.occurrence) || item.occurrence < 0) {
      throw new Error(`plan item ${index} occurrence must be an integer >= 0`)
    }
    if (typeof item.matched !== 'string' || item.matched.length === 0) {
      throw new Error(`plan item ${index} matched must be a non-empty string`)
    }
    if (typeof item.replacement !== 'string' || item.replacement.length === 0) {
      throw new Error(`plan item ${index} replacement must be a non-empty string`)
    }
    if (item.replacement === item.matched) {
      throw new Error(`plan item ${index} replacement must differ from matched`)
    }
    if (typeof item.expected_line_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.expected_line_sha256)) {
      throw new Error(`plan item ${index} expected_line_sha256 must be 64 lowercase hexadecimal characters`)
    }
  }
  return items
}

export const assertValidPlanDocument = plan => {
  validatePlanItems(plan?.items)
  assertValidDocument(plan, { type: 'plan' })
  return plan
}

export const readJsonDocument = file => {
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch (error) {
    throw new Error(`could not read ${file}: ${error.message}`)
  }
  let source
  try {
    source = utf8Decoder.decode(bytes)
  } catch {
    throw new Error(`invalid UTF-8 in ${file}`)
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`)
  }
}

export const validateDocumentFile = (file, { type = null } = {}) => {
  const document = readJsonDocument(file)
  const result = validateDocument(document, { type, file })
  return { ...result, document }
}
