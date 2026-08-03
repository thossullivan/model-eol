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

const groupItems = items => {
  const groups = new Map()
  for (const item of items) {
    const file = item.resolvedFile ?? item.file
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push(item)
  }
  return groups
}

const groupItemsByLine = items => {
  const groups = new Map()
  for (const item of items) {
    if (!groups.has(item.line)) groups.set(item.line, [])
    groups.get(item.line).push(item)
  }
  return groups
}

const MAX_RESTORE_ITEMS = 16
const MAX_RESTORE_STATES = 10000

const locateOccurrences = (line, items) => {
  const locations = []
  const failures = []
  for (const item of items) {
    const index = occurrenceIndex(line, item.matched, item.occurrence)
    if (index === -1) {
      failures.push({ item, message: 'expected occurrence of matched text is missing' })
      continue
    }
    locations.push({ item, index })
  }
  return { locations, failures }
}

const locateReplacements = (line, items) => {
  const located = locateOccurrences(line, items)
  if (located.failures.length) return located
  const seen = new Set()
  const failures = []
  const locations = []
  for (const location of located.locations) {
    const key = `${location.item.line}:${location.index}`
    if (seen.has(key)) {
      failures.push({ item: location.item, message: 'duplicate occurrence in plan' })
      continue
    }
    seen.add(key)
    locations.push(location)
  }
  return { locations, failures }
}

const applyLocatedReplacements = (line, locations) => {
  let updated = line
  for (const { item, index } of locations.toSorted((a, b) => b.index - a.index)) {
    updated = updated.slice(0, index) + item.replacement + updated.slice(index + item.matched.length)
  }
  return updated
}

const hasExpectedPreImage = (line, items) => {
  const expected = items[0].expected_line_sha256
  return items.every(item => item.expected_line_sha256 === expected) && sha256(line) === expected
}

const restoreGroup = (postImage, items) => {
  const expected = items[0].expected_line_sha256
  if (!items.every(item => item.expected_line_sha256 === expected)) return null
  if (items.length > MAX_RESTORE_ITEMS) return null

  const descriptors = items.map((item, planIndex) => ({ item, planIndex }))
  const visited = new Set()
  const search = (line, remaining) => {
    if (visited.size >= MAX_RESTORE_STATES) return null
    const state = `${remaining.map(({ planIndex }) => planIndex).join(',')}\u0000${line}`
    if (visited.has(state)) return null
    visited.add(state)

    if (remaining.length === 0) {
      if (sha256(line) !== expected) return null
      const located = locateReplacements(line, items)
      if (located.failures.length) return null
      return applyLocatedReplacements(line, located.locations) === postImage ? line : null
    }

    for (const [remainingIndex, { item }] of remaining.entries()) {
      let cursor = 0
      while (true) {
        const index = line.indexOf(item.replacement, cursor)
        if (index === -1) break
        const restored = line.slice(0, index) + item.matched + line.slice(index + item.replacement.length)
        const next = remaining.slice(0, remainingIndex).concat(remaining.slice(remainingIndex + 1))
        const result = search(restored, next)
        if (result !== null) return result
        cursor = index + item.replacement.length
      }
    }
    return null
  }

  return search(postImage, descriptors)
}

const temporaryFileFor = file => path.join(
  path.dirname(file),
  `.model-eol-${path.basename(file)}-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`,
)

const writeAtomically = (file, content) => {
  const temporaryFile = temporaryFileFor(file)
  try {
    const mode = fs.statSync(file).mode & 0o7777
    fs.writeFileSync(temporaryFile, content, { encoding: 'utf8', flag: 'wx', mode })
    fs.chmodSync(temporaryFile, mode)
    fs.renameSync(temporaryFile, file)
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile)
    } catch {
    }
    throw error
  }
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
  for (const [planIndex, item] of plan.items.entries()) {
    try {
      prepared.push({ ...item, planIndex, resolvedFile: resolvePlanFile(rootDir, item.file) })
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
    let ready = []
    const already = []
    const failures = []

    const readyGroups = []
    for (const [lineNumber, lineItems] of groupItemsByLine(items)) {
      const line = lines[lineNumber - 1]
      if (line === undefined) {
        for (const item of lineItems) failures.push({ item, message: 'line is not present' })
        continue
      }

      if (lineItems.length > MAX_RESTORE_ITEMS) {
        for (const item of lineItems) failures.push({ item, message: 'line hash does not match expected_line_sha256' })
        continue
      }

      if (hasExpectedPreImage(line, lineItems)) {
        const located = locateOccurrences(line, lineItems)
        failures.push(...located.failures)
        const failedItems = new Set(located.failures.map(failure => failure.item))
        const groupReady = lineItems.filter(item => !failedItems.has(item))
        ready.push(...groupReady)
        readyGroups.push({ lineNumber, items: groupReady, locations: located.locations })
        continue
      }

      if (restoreGroup(line, lineItems) !== null) already.push(...lineItems)
      else {
        for (const item of lineItems) failures.push({ item, message: 'line hash does not match expected_line_sha256' })
      }
    }

    if (failures.length) {
      ready.sort((a, b) => a.planIndex - b.planIndex)
      already.sort((a, b) => a.planIndex - b.planIndex)
      failures.sort((a, b) => a.item.planIndex - b.item.planIndex)
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

    const duplicateFailures = []
    const duplicateItems = new Set()
    for (const readyGroup of readyGroups) {
      const located = locateReplacements(lines[readyGroup.lineNumber - 1], readyGroup.items)
      duplicateFailures.push(...located.failures)
      for (const failure of located.failures) duplicateItems.add(failure.item)
      readyGroup.locations = located.locations
      readyGroup.items = readyGroup.items.filter(item => !duplicateItems.has(item))
    }
    if (duplicateFailures.length) {
      ready = ready.filter(item => !duplicateItems.has(item))
      failures.push(...duplicateFailures)
      ready.sort((a, b) => a.planIndex - b.planIndex)
      already.sort((a, b) => a.planIndex - b.planIndex)
      failures.sort((a, b) => a.item.planIndex - b.item.planIndex)
      for (const failure of failures) {
        printError(failure.item, failure.message)
        failed++
      }
      for (const item of ready) {
        printError(item, 'another item for this file failed validation; file was not changed')
        failed++
      }
      continue
    }

    ready.sort((a, b) => a.planIndex - b.planIndex)
    already.sort((a, b) => a.planIndex - b.planIndex)

    const updatedLines = lines.slice()
    for (const { lineNumber, locations } of readyGroups) {
      updatedLines[lineNumber - 1] = applyLocatedReplacements(lines[lineNumber - 1], locations)
    }
    const updatedContent = updatedLines.join('\n')

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

    let latestText
    try {
      latestText = fs.readFileSync(file, 'utf8')
    } catch (e) {
      for (const item of ready) {
        printError(item, `write failed: ${e.message}`)
        failed++
      }
      continue
    }
    const latestLines = latestText.split('\n')
    const latestReadyGroups = []
    const verificationFailures = []
    for (const { lineNumber, items: lineItems } of readyGroups) {
      const line = latestLines[lineNumber - 1]
      if (line === undefined) {
        for (const item of lineItems) verificationFailures.push({ item, message: 'line is not present' })
        continue
      }
      if (!hasExpectedPreImage(line, lineItems)) {
        for (const item of lineItems) verificationFailures.push({ item, message: 'line hash does not match expected_line_sha256' })
        continue
      }
      const located = locateReplacements(line, lineItems)
      if (located.failures.length) {
        verificationFailures.push(...located.failures)
        continue
      }
      latestReadyGroups.push({ lineNumber, locations: located.locations })
    }
    verificationFailures.sort((a, b) => a.item.planIndex - b.item.planIndex)
    if (verificationFailures.length) {
      for (const failure of verificationFailures) {
        printError(failure.item, failure.message)
        failed++
      }
      const verificationFailedItems = new Set(verificationFailures.map(failure => failure.item))
      for (const item of ready) {
        if (!verificationFailedItems.has(item)) {
          printError(item, 'another item for this file failed validation; file was not changed')
          failed++
        }
      }
      continue
    }

    const latestUpdatedLines = latestLines.slice()
    for (const { lineNumber, locations } of latestReadyGroups) {
      latestUpdatedLines[lineNumber - 1] = applyLocatedReplacements(latestLines[lineNumber - 1], locations)
    }
    try {
      writeAtomically(file, latestText === text ? updatedContent : latestUpdatedLines.join('\n'))
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
