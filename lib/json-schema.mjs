const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const sameJsonValue = (left, right) => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]))
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every(key =>
      Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
  }
  return false
}

const jsonType = value => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

const matchesType = (value, type) => {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isObject(value)
  if (type === 'integer') return Number.isFinite(value) && Number.isInteger(value)
  if (type === 'number') return Number.isFinite(value) && typeof value === 'number'
  return typeof value === type
}

const propertyPath = (base, property) =>
  /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(property)
    ? `${base}.${property}`
    : `${base}[${JSON.stringify(property)}]`

const isCalendarDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year >= 0 && year <= 99) date.setUTCFullYear(year)
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}

const isDateTime = value => {
  if (typeof value !== 'string') return false
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/)
  if (!match || !isCalendarDate(match[1])) return false
  const hour = Number(match[2])
  const minute = Number(match[3])
  const second = Number(match[4])
  const offsetHour = match[6] === undefined ? 0 : Number(match[6])
  const offsetMinute = match[7] === undefined ? 0 : Number(match[7])
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 && !Number.isNaN(Date.parse(value))
}

const isUri = value => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  try {
    return Boolean(new URL(value).protocol)
  } catch {
    return false
  }
}

const FORMAT_VALIDATORS = new Map([
  ['date', isCalendarDate],
  ['date-time', isDateTime],
  ['uri', isUri],
])

const withoutFragment = value => value.split('#', 1)[0]

const decodePointer = fragment => {
  if (!fragment) return []
  const decoded = decodeURIComponent(fragment)
  if (!decoded.startsWith('/')) throw new Error(`unsupported JSON Schema fragment #${fragment}`)
  return decoded.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}

const atPointer = (root, fragment, reference) => {
  let value = root
  for (const token of decodePointer(fragment)) {
    if ((isObject(value) || Array.isArray(value)) && Object.hasOwn(value, token)) value = value[token]
    else throw new Error(`unresolved JSON Schema reference ${reference}`)
  }
  return value
}

export class JsonSchemaRegistry {
  constructor(schemas) {
    this.schemas = new Map()
    this.ids = new WeakMap()
    for (const schema of schemas) this.add(schema)
  }

  add(schema) {
    if (!isObject(schema) || typeof schema.$id !== 'string' || !schema.$id) {
      throw new Error('each registered JSON Schema must have a non-empty $id')
    }
    let id
    try {
      id = withoutFragment(new URL(schema.$id).href)
    } catch {
      throw new Error(`JSON Schema has an invalid $id: ${schema.$id}`)
    }
    const previous = this.schemas.get(id)
    if (previous && previous !== schema) throw new Error(`duplicate JSON Schema $id: ${id}`)
    this.schemas.set(id, schema)
    this.ids.set(schema, id)
    return this
  }

  idFor(schema) {
    const id = this.ids.get(schema)
    if (!id) throw new Error('JSON Schema is not registered')
    return id
  }

  resolve(reference, fromRoot) {
    const base = this.idFor(fromRoot)
    let resolved
    try {
      resolved = new URL(reference, base)
    } catch {
      throw new Error(`invalid JSON Schema reference ${reference}`)
    }
    const rootId = withoutFragment(resolved.href)
    const root = this.schemas.get(rootId)
    if (!root) throw new Error(`unresolved JSON Schema reference ${reference} from ${base}`)
    const fragment = resolved.hash ? resolved.hash.slice(1) : ''
    return { schema: atPointer(root, fragment, reference), root }
  }

  assertReferences() {
    const seen = new Set()
    const visit = (value, root) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      if (typeof value.$ref === 'string') this.resolve(value.$ref, root)
      if (Array.isArray(value)) {
        for (const item of value) visit(item, root)
      } else {
        for (const item of Object.values(value)) visit(item, root)
      }
    }
    for (const root of this.schemas.values()) visit(root, root)
    return true
  }
}

const describeTypes = types => types.length === 1 ? types[0] : `one of: ${types.join(', ')}`

export const validateJsonSchema = (value, schema, { registry = new JsonSchemaRegistry([schema]) } = {}) => {
  const errors = []
  const fail = (path, keyword, message) => errors.push({ path, keyword, message })

  const validate = (instance, rule, path, root) => {
    if (typeof rule === 'boolean') {
      if (!rule) fail(path, 'falseSchema', 'is not allowed')
      return
    }
    if (!isObject(rule)) throw new Error(`invalid JSON Schema rule at ${path}`)

    if (typeof rule.$ref === 'string') {
      const resolved = registry.resolve(rule.$ref, root)
      validate(instance, resolved.schema, path, resolved.root)
      return
    }

    if (Array.isArray(rule.allOf)) {
      for (const member of rule.allOf) validate(instance, member, path, root)
    }
    if (Array.isArray(rule.oneOf)) {
      let matches = 0
      for (const member of rule.oneOf) {
        const errorCount = errors.length
        validate(instance, member, path, root)
        if (errors.length === errorCount) matches++
        else errors.splice(errorCount)
      }
      if (matches !== 1) fail(path, 'oneOf', `must match exactly one schema; matched ${matches}`)
    }

    const declaredTypes = rule.type === undefined
      ? []
      : Array.isArray(rule.type) ? rule.type : [rule.type]
    if (declaredTypes.length && !declaredTypes.some(type => matchesType(instance, type))) {
      fail(path, 'type', `must be ${describeTypes(declaredTypes)}; got ${jsonType(instance)}`)
      return
    }

    if (Object.hasOwn(rule, 'const') && !sameJsonValue(instance, rule.const)) {
      fail(path, 'const', `must equal ${JSON.stringify(rule.const)}`)
    }
    if (Array.isArray(rule.enum) && !rule.enum.some(candidate => sameJsonValue(instance, candidate))) {
      fail(path, 'enum', `must be one of ${rule.enum.map(candidate => JSON.stringify(candidate)).join(', ')}`)
    }

    if (typeof instance === 'string') {
      if (Number.isInteger(rule.minLength) && instance.length < rule.minLength) {
        fail(path, 'minLength', `must have at least ${rule.minLength} character(s)`)
      }
      if (Number.isInteger(rule.maxLength) && instance.length > rule.maxLength) {
        fail(path, 'maxLength', `must have at most ${rule.maxLength} character(s)`)
      }
      if (typeof rule.pattern === 'string' && !(new RegExp(rule.pattern)).test(instance)) {
        fail(path, 'pattern', `must match pattern ${rule.pattern}`)
      }
      if (typeof rule.format === 'string') {
        const formatValidator = FORMAT_VALIDATORS.get(rule.format)
        if (!formatValidator) throw new Error(`unsupported JSON Schema format ${rule.format}`)
        if (!formatValidator(instance)) fail(path, 'format', `must match format ${rule.format}`)
      }
    }

    if (typeof instance === 'number' && Number.isFinite(instance)) {
      if (typeof rule.minimum === 'number' && instance < rule.minimum) {
        fail(path, 'minimum', `must be >= ${rule.minimum}`)
      }
      if (typeof rule.maximum === 'number' && instance > rule.maximum) {
        fail(path, 'maximum', `must be <= ${rule.maximum}`)
      }
    }

    if (Array.isArray(instance)) {
      if (Number.isInteger(rule.minItems) && instance.length < rule.minItems) {
        fail(path, 'minItems', `must contain at least ${rule.minItems} item(s)`)
      }
      if (Number.isInteger(rule.maxItems) && instance.length > rule.maxItems) {
        fail(path, 'maxItems', `must contain at most ${rule.maxItems} item(s)`)
      }
      if (rule.uniqueItems === true) {
        for (let index = 0; index < instance.length; index++) {
          if (instance.slice(0, index).some(item => sameJsonValue(item, instance[index]))) {
            fail(`${path}[${index}]`, 'uniqueItems', 'must not duplicate another array item')
          }
        }
      }
      if (rule.items !== undefined) {
        instance.forEach((item, index) => validate(item, rule.items, `${path}[${index}]`, root))
      }
    }

    if (isObject(instance)) {
      const properties = isObject(rule.properties) ? rule.properties : {}
      if (Array.isArray(rule.required)) {
        for (const property of rule.required) {
          if (!Object.hasOwn(instance, property)) fail(propertyPath(path, property), 'required', 'is required')
        }
      }
      for (const [property, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(instance, property)) validate(instance[property], propertySchema, propertyPath(path, property), root)
      }
      if (isObject(rule.dependencies)) {
        for (const [property, dependencies] of Object.entries(rule.dependencies)) {
          if (!Object.hasOwn(instance, property)) continue
          if (Array.isArray(dependencies)) {
            for (const dependency of dependencies) {
              if (!Object.hasOwn(instance, dependency)) {
                fail(propertyPath(path, dependency), 'dependencies', `is required when ${property} is present`)
              }
            }
          } else {
            validate(instance, dependencies, path, root)
          }
        }
      }
      for (const property of Object.keys(instance)) {
        if (Object.hasOwn(properties, property)) continue
        if (rule.additionalProperties === false) {
          fail(propertyPath(path, property), 'additionalProperties', 'is not allowed')
        } else if (isObject(rule.additionalProperties) || typeof rule.additionalProperties === 'boolean') {
          validate(instance[property], rule.additionalProperties, propertyPath(path, property), root)
        }
      }
    }
  }

  const root = schema
  registry.idFor(root)
  validate(value, schema, '$', root)
  return errors
}

export const assertJsonSchema = (value, schema, options = {}) => {
  const errors = validateJsonSchema(value, schema, options)
  if (errors.length) throw new Error(errors.map(error => `${error.path}: ${error.message}`).join('\n'))
  return value
}
