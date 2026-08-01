import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

const occurrenceIndex = (line, value, occurrence) => {
  if (!value || !Number.isInteger(occurrence) || occurrence < 0) return -1
  let cursor = 0
  for (let i = 0; i <= occurrence; i++) {
    const index = line.indexOf(value, cursor)
    if (index === -1) return -1
    if (i === occurrence) return index
    cursor = index + value.length
  }
  return -1
}

const itemLabel = item => `${item.file}:${item.line}`

const printError = (item, message) => {
  console.error(`model-eol: apply refused ${itemLabel(item)}: ${message}`)
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
    if (typeof item.expected_line_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.expected_line_sha256)) {
      throw new Error(`plan item ${index} expected_line_sha256 must be 64 lowercase hexadecimal characters`)
    }
  }
  return items
}

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const realPathForContainment = value => {
  let current = value
  const suffix = []
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...suffix)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return value
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

const resolvePlanFile = (rootDir, file) => {
  const lexicalRoot = path.resolve(rootDir)
  const root = fs.realpathSync(lexicalRoot)
  if (file.split(/[\\/]/).includes('..')) throw new Error('file path contains .. traversal')
  const resolved = path.resolve(lexicalRoot, file)
  if (!path.isAbsolute(file) && !isInside(lexicalRoot, resolved)) throw new Error('file resolves outside rootDir')
  const realFile = realPathForContainment(resolved)
  if (!isInside(root, realFile)) throw new Error('file resolves outside rootDir')
  return resolved
}

const isAlreadyApplied = (line, item) => {
  if (!item.replacement) return false
  let cursor = 0
  while (true) {
    const index = line.indexOf(item.replacement, cursor)
    if (index === -1) return false
    const restored = line.slice(0, index) + item.matched + line.slice(index + item.replacement.length)
    if (sha256(restored) === item.expected_line_sha256) return true
    cursor = index + item.replacement.length
  }
}

const groupItems = items => {
  const groups = new Map()
  for (const item of items) {
    const file = item.resolvedFile ?? item.file
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push(item)
  }
  return groups
}

export const applyPlan = ({ planPath, dryRun = false, rootDir }) => {
  if (typeof rootDir !== 'string' || rootDir.length === 0) throw new Error('applyPlan requires rootDir')
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan must be an object')
  validatePlanItems(plan.items)

  let failed = 0
  let applied = 0
  let alreadyApplied = 0

  const prepared = []
  for (const item of plan.items) {
    try {
      prepared.push({ ...item, resolvedFile: resolvePlanFile(rootDir, item.file) })
    } catch (error) {
      printError(item, error.message)
      failed++
    }
  }

  for (const [file, items] of groupItems(prepared)) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      for (const item of items) {
        printError(item, `unreadable file: ${e.message}`)
        failed++
      }
      continue
    }

    const lines = text.split('\n')
    const ready = []
    const already = []
    const failures = []

    for (const item of items) {
      const line = lines[item.line - 1]
      if (line === undefined) {
        failures.push({ item, message: 'line is not present' })
        continue
      }
      if (sha256(line) !== item.expected_line_sha256) {
        if (isAlreadyApplied(line, item)) already.push(item)
        else failures.push({ item, message: 'line hash does not match expected_line_sha256' })
        continue
      }
      if (occurrenceIndex(line, item.matched, item.occurrence) === -1) {
        failures.push({ item, message: 'expected occurrence of matched text is missing' })
        continue
      }
      ready.push(item)
    }

    if (failures.length) {
      for (const failure of failures) {
        printError(failure.item, failure.message)
        failed++
      }
      for (const item of ready) {
        printError(item, 'another item for this file failed validation; file was not changed')
        failed++
      }
      for (const item of already) {
        console.log(`already-applied ${itemLabel(item)}: ${item.matched} -> ${item.replacement}`)
        alreadyApplied++
      }
      continue
    }

    const updatedLines = lines.slice()
    const locations = new Set()
    const replacements = new Map()
    for (const item of ready) {
      const line = lines[item.line - 1]
      const index = occurrenceIndex(line, item.matched, item.occurrence)
      const location = `${item.line}:${index}`
      if (locations.has(location)) {
        failures.push({ item, message: 'duplicate occurrence in plan' })
        continue
      }
      locations.add(location)
      if (!replacements.has(item.line)) replacements.set(item.line, [])
      replacements.get(item.line).push({ item, index })
    }
    if (failures.length) {
      for (const failure of failures) {
        printError(failure.item, failure.message)
        failed++
      }
      for (const item of ready) {
        if (!failures.some(failure => failure.item === item)) {
          printError(item, 'another item for this file failed validation; file was not changed')
          failed++
        }
      }
      continue
    }

    for (const [lineNumber, lineReplacements] of replacements) {
      let updated = lines[lineNumber - 1]
      for (const { item, index } of lineReplacements.sort((a, b) => b.index - a.index)) {
        updated = updated.slice(0, index) + item.replacement + updated.slice(index + item.matched.length)
      }
      updatedLines[lineNumber - 1] = updated
    }

    for (const item of already) {
      console.log(`already-applied ${itemLabel(item)}: ${item.matched} -> ${item.replacement}`)
      alreadyApplied++
    }
    if (!ready.length) continue

    if (dryRun) {
      for (const item of ready) {
        console.log(`would change ${itemLabel(item)}: ${item.matched} -> ${item.replacement}`)
      }
      continue
    }

    try {
      fs.writeFileSync(file, updatedLines.join('\n'), 'utf8')
    } catch (e) {
      for (const item of ready) {
        printError(item, `write failed: ${e.message}`)
        failed++
      }
      continue
    }
    for (const item of ready) {
      console.log(`applied ${itemLabel(item)}: ${item.matched} -> ${item.replacement}`)
      applied++
    }
  }

  return { failed, applied, alreadyApplied }
}
