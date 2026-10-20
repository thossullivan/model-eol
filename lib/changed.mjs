import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { configForRepoPath, mappedRoutesForRepoPath, repoPathMatches, routesForRepoPath } from './config.mjs'
import { isBad } from './feeds.mjs'
import { MAX_FILE_BYTES, SKIP_DIRS, baseLineFor, changedLinesForTargets, displayPath, incompleteScanNotes, isAddedLine } from './scanner.mjs'

export class BaseUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BaseUnavailableError'
  }
}

export const inCheckScope = finding =>
  finding.effective_scope !== 'direct' || finding.usage === 'direct-api' || finding.usage === 'model-reference'

const MAX_SYMLINK_DEPTH = 40
const SUBMODULE_GIT_CONFIG = ['-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false']

const runGit = (gitRoot, label, args, { input, hardened = false } = {}) => {
  const result = spawnSync('git', hardened ? [...SUBMODULE_GIT_CONFIG, ...args] : args, {
    cwd: gitRoot,
    input,
    env: hardened ? { ...process.env, GIT_NO_LAZY_FETCH: '1' } : process.env,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`
    throw new Error(`git ${label} failed: ${detail}`)
  }
  return result.stdout
}

const nulRecords = buffer => buffer.toString('utf8').split('\0').filter(Boolean)

const repoRelative = (gitRoot, absolute) => {
  const relative = path.relative(gitRoot, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

const onDiskName = (directory, name) => {
  try {
    const names = fs.readdirSync(directory)
    if (names.includes(name)) return name
    const wanted = fs.lstatSync(path.join(directory, name))
    return names.find(other => {
      const stat = fs.lstatSync(path.join(directory, other))
      return stat.dev === wanted.dev && stat.ino === wanted.ino
    }) ?? name
  } catch {
    return name
  }
}

const lexicalRepoPath = (gitRoot, absolute) => {
  const parts = path.resolve(absolute).split(path.sep)
  for (let index = 1; index <= parts.length; index++) {
    let real
    try {
      real = fs.realpathSync(parts.slice(0, index).join(path.sep) || path.sep)
    } catch {
      return null
    }
    if (real !== gitRoot) continue
    const names = []
    for (const part of parts.slice(index)) names.push(onDiskName(path.join(gitRoot, ...names), part))
    return names.join('/')
  }
  return null
}

const nativeRealpath = target => {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return null
  }
}

const repoLocation = (gitRoot, target) => {
  const physical = nativeRealpath(target)
  const lexical = lexicalRepoPath(gitRoot, target)
  // path.resolve folds "link/.." before the OS follows link, so trust the lexical path only when both agree.
  if (lexical !== null && (physical === null || nativeRealpath(path.resolve(target)) === physical)) return lexical
  return physical === null ? null : repoRelative(gitRoot, physical)
}

const isIgnored = (gitRoot, relative) => {
  if (relative === '') return false
  const result = spawnSync('git', ['check-ignore', '-q', '--', `./${relative}`], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (!result.error && (result.status === 0 || result.status === 1)) return result.status === 0
  const detail = String(result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`
  if (result.status === 128 && /in submodule|beyond a symbolic link/i.test(detail)) return false
  throw new Error(`git check-ignore failed: ${detail}`)
}

const readRegular = absolute => {
  let descriptor
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
  } catch (error) {
    return error.code === 'ENOENT' ? { bytes: null } : { message: error.message }
  }
  try {
    return fs.fstatSync(descriptor).isFile() ? { bytes: fs.readFileSync(descriptor) } : { message: 'not a regular file' }
  } catch (error) {
    return { message: error.message }
  } finally {
    fs.closeSync(descriptor)
  }
}

const readHead = absolute => {
  const result = readRegular(absolute)
  if (result.message) throw new Error(`could not read ${absolute}: ${result.message}`)
  return result.bytes
}

const scannableTreePath = relative => relative.split('/').every(part =>
  part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !SKIP_DIRS.has(part))

const regularBlob = entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')

const untrackedFiles = (gitRoot, relativeTargets) => new Set(nulRecords(runGit(gitRoot, 'ls-files', [
  '-c', 'core.fsmonitor=false', '--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...relativeTargets,
])).filter(relative => !relative.endsWith('/')).map(relative => path.resolve(gitRoot, relative)))

const HASH_CHUNK_BYTES = 64 * 1024

// Hashes raw bytes with paths as literal arguments: --stdin-paths unquotes names, and filters would run PR-routed drivers.
const rawOids = (gitRoot, relatives) => {
  const oids = []
  for (let start = 0; start < relatives.length;) {
    let end = start
    let bytes = 0
    while (end < relatives.length && (end === start || bytes + relatives[end].length < HASH_CHUNK_BYTES)) bytes += relatives[end++].length + 1
    const chunk = relatives.slice(start, end)
    let output = []
    try {
      output = runGit(gitRoot, 'hash-object', ['hash-object', '--no-filters', '--', ...chunk]).toString('utf8').split('\n')
    } catch {
    }
    for (let index = 0; index < chunk.length; index++) oids.push(output[index] ?? null)
    start = end
  }
  return oids
}

// git diff trusts index stat data and skips assume-unchanged and skip-worktree entries, so compare the bytes the scanner reads.
const editedWithoutHunks = (gitRoot, checks, baseListing) => {
  if (!checks.length) return new Set()
  const listing = baseListing()
  const hashable = checks.filter(check => listing.get(check.baseRelative)?.type === 'blob')
  const oids = rawOids(gitRoot, hashable.map(check => check.headRelative))
  const same = new Set(hashable.filter((check, index) => oids[index] === listing.get(check.baseRelative).oid).map(check => check.absolute))
  return new Set(checks.filter(check => !same.has(check.absolute)).map(check => check.absolute))
}

const parseTree = output => {
  const entries = new Map()
  for (const record of nulRecords(output)) {
    const separator = record.indexOf('\t')
    const [mode, type, oid, size] = record.slice(0, separator).split(/ +/)
    if (separator === -1 || !/^[0-7]{6}$/.test(mode) || !/^[0-9a-f]{40,64}$/.test(oid ?? '')) {
      throw new Error('git ls-tree returned a malformed record')
    }
    entries.set(record.slice(separator + 1), { mode, type, oid, size: size === '-' ? null : Number(size) })
  }
  return entries
}

const readBlobs = (gitRoot, entries, { hardened = false } = {}) => {
  const output = runGit(gitRoot, 'cat-file', ['cat-file', '--batch'], { input: entries.map(entry => `${entry.oid}\n`).join(''), hardened })
  const blobs = []
  let offset = 0
  for (const entry of entries) {
    const newline = output.indexOf(0x0a, offset)
    if (newline === -1) throw new Error('git cat-file returned a truncated record')
    const [oid, type, size] = output.toString('utf8', offset, newline).split(' ')
    if (oid !== entry.oid || type !== 'blob' || !/^\d+$/.test(size ?? '')) {
      throw new Error(`git cat-file could not read blob ${entry.oid}`)
    }
    const start = newline + 1
    const end = start + Number(size)
    if (end + 1 > output.length) throw new Error('git cat-file returned a truncated record')
    blobs.push(output.subarray(start, end))
    offset = end + 1
  }
  return blobs
}

const baseTreeReader = (gitRoot, baseCommit, { hardened = false } = {}) => {
  const lsTree = (pathspecs, { recursive = false } = {}) => parseTree(runGit(gitRoot, 'ls-tree', [
    '--literal-pathspecs', 'ls-tree', ...(recursive ? ['-r'] : []), '-z', '-l', '--full-tree', baseCommit,
    ...(pathspecs.length ? ['--', ...pathspecs] : []),
  ], { hardened }))
  const entries = new Map()
  const lookup = relative => {
    if (!entries.has(relative)) entries.set(relative, lsTree([relative]).get(relative) ?? null)
    return entries.get(relative)
  }
  const blobs = new Map()
  const read = entry => {
    if (!blobs.has(entry.oid)) blobs.set(entry.oid, readBlobs(gitRoot, [entry], { hardened })[0])
    return blobs.get(entry.oid)
  }
  const children = relative => [...lsTree(relative === '' ? [] : [`${relative}/`])].map(([child, entry]) => ({
    name: relative === '' ? child : child.slice(relative.length + 1),
    entry,
  }))
  const followTarget = (parent, target, depth) => {
    const parts = target.split('/')
    let current = parent
    let unresolved = false
    for (const [index, part] of parts.entries()) {
      if (part === '' || part === '.') continue
      if (part !== '..') {
        current = current ? `${current}/${part}` : part
        unresolved = true
        continue
      }
      if (unresolved) {
        const directory = resolve(current, depth + 1)
        if (directory.state !== 'tree') {
          return { result: directory.state === 'absent' ? { state: 'absent' } : { state: 'unavailable', message: `symbolic link target ${target} does not resolve to a directory` } }
        }
        current = directory.relative
        unresolved = false
      }
      if (current === '') return { escaped: path.join(path.dirname(gitRoot), ...parts.slice(index + 1)) }
      current = path.posix.dirname(current) === '.' ? '' : path.posix.dirname(current)
    }
    return { relative: current }
  }
  const resolve = (relative, depth = 0) => {
    if (depth > MAX_SYMLINK_DEPTH) return { state: 'unavailable', message: 'too many levels of symbolic links' }
    const parts = relative === '' ? [] : relative.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/')
      const entry = lookup(prefix)
      if (!entry) return { state: 'absent' }
      const rest = parts.slice(index)
      if (entry.mode === '160000') return { state: 'submodule', prefix, commit: entry.oid, rest: rest.join('/') }
      if (entry.mode === '120000') {
        const target = read(entry).toString('utf8')
        const parent = path.posix.dirname(prefix) === '.' ? '' : path.posix.dirname(prefix)
        if (path.posix.isAbsolute(target) && target.split('/').includes('..')) {
          return { state: 'unavailable', message: `absolute symbolic link target ${target} contains ..` }
        }
        const followed = path.posix.isAbsolute(target) ? { escaped: path.resolve(target) } : followTarget(parent, target, depth)
        if (followed.result) return followed.result
        if (followed.relative !== undefined) return resolve([followed.relative, ...rest].filter(Boolean).join('/'), depth + 1)
        const absolute = followed.escaped
        const inside = repoRelative(gitRoot, absolute) ?? lexicalRepoPath(gitRoot, absolute)
        if (inside === null) return { state: 'outside', absolute: path.join(absolute, ...rest) }
        return resolve([inside, ...rest].filter(Boolean).join('/'), depth + 1)
      }
      if (rest.length && entry.type !== 'tree') return { state: 'absent' }
      if (!rest.length && entry.type !== 'tree') {
        return regularBlob(entry) ? { state: 'blob', entry } : { state: 'unavailable', message: 'not a regular file' }
      }
    }
    return { state: 'tree', relative }
  }
  return { root: gitRoot, hardened, lsTree, read, children, resolve }
}

const submoduleReader = (reader, prefix, commit) => {
  const unavailable = { state: 'unavailable', message: `in submodule ${prefix}, which is not checked out with base commit ${commit}` }
  const candidate = path.join(reader.root, ...prefix.split('/'))
  let root
  try {
    root = fs.realpathSync(candidate)
    // A PR can commit a directory laid out as a git dir, but never a .git entry or a gitlink's checkout.
    if (root !== candidate || !fs.lstatSync(root).isDirectory() || !fs.existsSync(path.join(root, '.git'))) return unavailable
    const index = runGit(reader.root, 'ls-files', ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', prefix], { hardened: reader.hardened })
    if (!nulRecords(index).some(record => record.startsWith('160000 ') && record.endsWith(`\t${prefix}`))) return unavailable
    const toplevel = runGit(root, 'rev-parse', ['rev-parse', '--show-toplevel'], { hardened: true }).toString('utf8').trim()
    if (fs.realpathSync(toplevel) !== root) return unavailable
  } catch {
    return unavailable
  }
  const present = spawnSync('git', [...SUBMODULE_GIT_CONFIG, 'cat-file', '-e', `${commit}^{commit}`], {
    cwd: root,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    stdio: 'ignore',
  })
  return present.status === 0 ? baseTreeReader(root, commit, { hardened: true }) : unavailable
}

const resolveBase = (reader, relative, depth = 0) => {
  const resolved = reader.resolve(relative)
  if (resolved.state !== 'submodule') return { ...resolved, reader }
  if (depth > MAX_SYMLINK_DEPTH) return { state: 'unavailable', message: 'too many nested submodules' }
  const submodule = submoduleReader(reader, resolved.prefix, resolved.commit)
  return submodule.state === 'unavailable' ? submodule : resolveBase(submodule, resolved.rest, depth + 1)
}

const sameBytes = (left, right) => left === null || right === null ? left === right : left.equals(right)

const configInput = ({ gitRoot, tree, configFile }) => {
  const location = repoLocation(gitRoot, configFile ?? path.join(gitRoot, '.model-eol.json'))
  if (location === null || location === '') return { changed: false }
  const resolved = resolveBase(tree, location)
  if (resolved.state === 'absent' && isIgnored(gitRoot, location)) return { changed: false }
  const head = configFile ? readHead(configFile) : null
  const base = resolved.state === 'blob' ? { bytes: resolved.reader.read(resolved.entry) }
    : resolved.state === 'absent' ? { bytes: null }
      : resolved.state === 'outside' ? readRegular(resolved.absolute)
        : { message: resolved.message ?? 'a directory' }
  if (base.message) return { changed: true, location, unavailable: `base config ${location} is ${base.message}` }
  return { changed: !sameBytes(head, base.bytes), location, bytes: base.bytes }
}

const readFeedDirectory = directory => {
  const files = new Map()
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const result = readRegular(path.join(directory, name))
    if (result.message || result.bytes === null) return { message: `entry ${name} is ${result.message ?? 'missing'}` }
    files.set(name, result.bytes)
  }
  return { files }
}

const feedsInput = ({ gitRoot, tree, feedsDir }) => {
  const location = repoLocation(gitRoot, feedsDir)
  if (location === null) return { changed: false }
  const directory = resolveBase(tree, location)
  if (directory.state === 'absent' && isIgnored(gitRoot, location)) return { changed: false }
  const label = location || '.'
  const headFiles = readFeedDirectory(feedsDir)
  if (headFiles.message) throw new Error(`could not read feeds ${feedsDir}: ${headFiles.message}`)
  const head = headFiles.files
  const unavailable = message => ({ changed: true, location, unavailable: `base feeds ${message}` })
  let base
  if (directory.state === 'tree') {
    base = new Map()
    const { reader } = directory
    for (const { name, entry } of reader.children(directory.relative)) {
      if (!name.endsWith('.json')) continue
      const resolved = regularBlob(entry) ? { state: 'blob', entry, reader }
        : entry.mode === '120000' ? resolveBase(reader, directory.relative ? `${directory.relative}/${name}` : name)
          : null
      const outside = resolved?.state === 'outside' ? readRegular(resolved.absolute) : null
      if (resolved?.state === 'blob') base.set(name, resolved.reader.read(resolved.entry))
      else if (outside?.bytes) base.set(name, outside.bytes)
      else return unavailable(`entry ${label}/${name} is not a readable regular file at base`)
    }
  } else if (directory.state === 'outside') {
    let listed
    try {
      listed = readFeedDirectory(directory.absolute)
    } catch (error) {
      return unavailable(`directory ${label} could not be read at base: ${error.message}`)
    }
    if (listed.message) return unavailable(`directory ${label} at base: ${listed.message}`)
    base = listed.files
  } else if (directory.state === 'unavailable') {
    return unavailable(`directory ${label} is ${directory.message}`)
  } else {
    return unavailable(`directory ${label} is ${directory.state === 'absent' ? 'missing' : 'not a directory'} at base`)
  }
  const changed = head.size !== base.size || [...head].some(([name, bytes]) => !base.has(name) || !bytes.equals(base.get(name)))
  return { changed, location, files: base }
}

const temporaryRoot = gitRoot => {
  const tmp = fs.realpathSync(os.tmpdir())
  if (repoRelative(gitRoot, tmp) !== null) {
    throw new Error(`the temporary directory ${tmp} is inside the git repository; set TMPDIR to a directory outside it`)
  }
  return fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'model-eol-base-')))
}

const findingKey = (relative, line, id, matched) => JSON.stringify([relative, line, id, matched])

const baseSummary = finding => ({
  status: finding.status,
  via: finding.via,
  usage: finding.usage,
  threshold_days: finding.threshold_days,
  effective_scope: finding.effective_scope,
})

// Waiver order, reason, and owner never change whether a finding is bad; route order does (the last match wins).
const policyKey = (config, repoPath, overrides) => {
  const policy = configForRepoPath(config, repoPath)
  return JSON.stringify({
    days: overrides.days === undefined ? policy.days : null,
    scope: overrides.scope === undefined ? policy.scope : null,
    via: overrides.via === undefined ? policy.via : null,
    ignore_models: [...policy.ignore.models].sort(),
    excluded: repoPathMatches(repoPath, policy.ignore.paths),
    waivers: policy.waivers.map(({ model, via = null, expires }) => JSON.stringify([model, via, expires])).sort(),
    routes: routesForRepoPath(config, repoPath).map(({ via, match = null, model = null }) => [via, match, model]),
  })
}

const feedRecords = feeds =>
  new Map([...feeds.entries.values()].map(record => [record.entry.id, JSON.stringify([record.publisher, record.entry])]))

const changedFeedIds = (head, base) => {
  const headRecords = feedRecords(head)
  const baseRecords = feedRecords(base)
  return new Set([...headRecords.keys(), ...baseRecords.keys()].filter(id => headRecords.get(id) !== baseRecords.get(id)))
}

const changedFeedKeys = (head, base) =>
  new Set([...head.keys, ...base.keys].filter(key => head.entries.get(key)?.entry.id !== base.entries.get(key)?.entry.id))

const inputNarrowing = ({ head, base, findings }) => {
  const ids = changedFeedIds(head.feeds, base.feeds)
  const keys = changedFeedKeys(head.feeds, base.feeds)
  const changedTarget = key => keys.has(key) || ids.has(head.feeds.entries.get(key)?.entry.id)
  const byFile = new Map()
  for (const finding of findings) {
    const absolute = path.resolve(finding.file)
    if (!byFile.has(absolute)) byFile.set(absolute, [])
    byFile.get(absolute).push(finding)
  }
  return {
    config: ({ absolute, baseRepoPath }) => baseRepoPath === null ||
      policyKey(head.config, head.repoPathFor(absolute), head.overrides) !== policyKey(base.config, baseRepoPath, head.overrides),
    feeds: ({ absolute }) => {
      const fileFindings = byFile.get(absolute) ?? []
      return fileFindings.some(finding => ids.has(finding.id) || keys.has(finding.matched)) ||
        (fileFindings.length > 0 && mappedRoutesForRepoPath(head.config, head.repoPathFor(absolute)).some(route => changedTarget(route.model)))
    },
  }
}

const materializeInputs = ({ tempRoot, baseRef, config, feeds }) => {
  const treeRoot = path.join(tempRoot, 'tree')
  fs.mkdirSync(treeRoot)
  const replacements = [[`${treeRoot}${path.sep}`, `${baseRef}:`], [treeRoot, `${baseRef}:`]]
  let configFile
  if (config.changed) {
    configFile = null
    if (config.bytes !== null) {
      configFile = path.join(tempRoot, 'config', path.posix.basename(config.location))
      fs.mkdirSync(path.dirname(configFile))
      fs.writeFileSync(configFile, config.bytes, { flag: 'wx' })
      replacements.unshift([configFile, `${baseRef}:${config.location}`])
    }
  }
  let feedsDir
  if (feeds.changed) {
    feedsDir = path.join(tempRoot, 'feeds')
    fs.mkdirSync(feedsDir)
    for (const [name, bytes] of feeds.files) fs.writeFileSync(path.join(feedsDir, name), bytes, { flag: 'wx' })
    replacements.unshift([`${feedsDir}${path.sep}`, `${baseRef}:${feeds.location ? `${feeds.location}/` : ''}`], [feedsDir, `${baseRef}:${feeds.location || '.'}`])
  }
  return { treeRoot, configFile, feedsDir, replacements }
}

const AFFECTED_INPUTS = ['config', 'feeds', 'rename', 'file', 'untracked']

export const selectChangedFindings = ({ targets, baseRef, includeDocs, findings, checkFindings, scannedFiles, configFile, feedsDir, head, loadBase, evaluateBase }) => {
  const diff = changedLinesForTargets(targets, baseRef, { includeDocs })
  const { gitRoot, baseCommit } = diff
  const tree = baseTreeReader(gitRoot, baseCommit)
  const untracked = untrackedFiles(gitRoot, diff.relativeTargets)
  const config = configInput({ gitRoot, tree, configFile })
  const feeds = feedsInput({ gitRoot, tree, feedsDir })
  let unavailable = (config.changed && config.unavailable) || (feeds.changed && feeds.unavailable) || null
  const stats = {
    scanned_files: scannedFiles.length,
    affected_files: 0,
    affected_by: Object.fromEntries(AFFECTED_INPUTS.map(input => [input, 0])),
    candidate_findings: 0,
    base_materialized_files: 0,
    base_scan_ms: 0,
    diff_mode: diff.stats.mode,
    diff_paths: diff.stats.paths,
    diff_runs: diff.stats.runs,
    diff_bytes: diff.stats.bytes,
    diff_dropped_bytes: diff.stats.droppedBytes,
    diff_fallback: diff.stats.fallback,
  }

  let tempRoot = null
  let materialized = null
  try {
    let baseInputs
    let narrowing = null
    if ((config.changed || feeds.changed) && unavailable === null) {
      try {
        tempRoot = temporaryRoot(gitRoot)
        materialized = materializeInputs({ tempRoot, baseRef, config, feeds })
        baseInputs = loadBase({ configFile: materialized.configFile, feedsDir: materialized.feedsDir })
        narrowing = inputNarrowing({ head, base: baseInputs, findings })
      } catch {
        // No narrowing: every file stays affected and the base step below succeeds or fails as it did before.
        if (tempRoot !== null) fs.rmSync(tempRoot, { recursive: true, force: true })
        tempRoot = null
        materialized = null
        baseInputs = undefined
        narrowing = null
      }
    }

    let listing = null
    const baseListing = () => (listing ??= tree.lsTree(diff.relativeTargets, { recursive: true }))
    const unaddedBad = checkFindings.filter(finding => !isAddedLine(diff.added, finding.file, finding.line) && isBad(finding))
    const contentChecks = [...new Set(unaddedBad.map(finding => path.resolve(finding.file)))].flatMap(absolute => {
      const record = diff.files.get(absolute)
      const headRelative = repoRelative(gitRoot, absolute)
      const baseRelative = record ? record.basePath : headRelative
      return record?.hunks.length || untracked.has(absolute) || headRelative === null || baseRelative === null ? [] : [{ absolute, headRelative, baseRelative }]
    })
    const edited = editedWithoutHunks(gitRoot, contentChecks, baseListing)

    const affected = new Map()
    for (const file of scannedFiles) {
      const absolute = path.resolve(file)
      const record = diff.files.get(absolute)
      const isUntracked = untracked.has(absolute)
      const baseRelative = isUntracked ? null : record ? record.basePath : repoRelative(gitRoot, absolute)
      const location = { absolute, baseRepoPath: baseRelative ?? repoRelative(gitRoot, absolute) }
      const inputs = [
        ...(config.changed && (narrowing === null || narrowing.config(location)) ? ['config'] : []),
        ...(feeds.changed && (narrowing === null || narrowing.feeds(location)) ? ['feeds'] : []),
        ...(record?.renamed ? ['rename'] : []),
        ...(record?.hunks.length || edited.has(absolute) ? ['file'] : []),
        ...(isUntracked ? ['untracked'] : []),
      ]
      if (!inputs.length) continue
      for (const input of inputs) stats.affected_by[input]++
      affected.set(absolute, { inputs, baseRelative, hunks: record?.hunks ?? [] })
    }
    stats.affected_files = affected.size

    const occurrences = new Map()
    const seen = new Map()
    for (const finding of findings) {
      const key = findingKey(path.resolve(finding.file), finding.line, finding.id, finding.matched)
      const index = seen.get(key) ?? 0
      seen.set(key, index + 1)
      occurrences.set(finding, index)
    }

    const candidates = checkFindings.filter(finding =>
      !isAddedLine(diff.added, finding.file, finding.line) && isBad(finding) && affected.has(path.resolve(finding.file)))
    stats.candidate_findings = candidates.length
    const baseRelatives = [...new Set(candidates
      .map(finding => affected.get(path.resolve(finding.file)).baseRelative)
      .filter(relative => relative !== null))]

    const baseFindings = new Map()
    const incomplete = new Set()
    if (baseRelatives.length && unavailable === null) {
      if (tempRoot === null) {
        tempRoot = temporaryRoot(gitRoot)
        materialized = materializeInputs({ tempRoot, baseRef, config, feeds })
      }
      const { treeRoot, replacements } = materialized
      const baseEntries = baseListing()
      const writes = []
      for (const relative of baseRelatives) {
        const entry = baseEntries.get(relative)
        if (!entry || !scannableTreePath(relative)) continue
        if (!regularBlob(entry) || entry.size > MAX_FILE_BYTES) {
          incomplete.add(relative)
          continue
        }
        writes.push({ relative, entry, target: path.join(treeRoot, ...relative.split('/')) })
      }
      const blobs = writes.length ? readBlobs(gitRoot, writes.map(write => write.entry)) : []
      const files = []
      for (const [index, write] of writes.entries()) {
        try {
          fs.mkdirSync(path.dirname(write.target), { recursive: true })
          fs.writeFileSync(write.target, blobs[index], { flag: 'wx' })
          files.push(write.target)
        } catch {
          incomplete.add(write.relative)
        }
      }
      stats.base_materialized_files = files.length
      if (files.length) {
        const relativeToTree = file => path.relative(treeRoot, path.resolve(file)).split(path.sep).join('/')
        const started = performance.now()
        try {
          const base = evaluateBase({
            treeRoot,
            files,
            configFile: materialized.configFile,
            feedsDir: materialized.feedsDir,
            inputs: baseInputs,
            classificationPathFor: file => displayPath(path.join(gitRoot, ...relativeToTree(file).split('/'))),
          })
          for (const note of incompleteScanNotes(base.notes)) if (note.file) incomplete.add(relativeToTree(note.file))
          for (const finding of base.findings) {
            const key = findingKey(relativeToTree(finding.file), finding.line, finding.id, finding.matched)
            if (!baseFindings.has(key)) baseFindings.set(key, [])
            baseFindings.get(key).push(finding)
          }
        } catch (error) {
          if (!(error instanceof BaseUnavailableError)) throw error
          unavailable = replacements.reduce((message, [from, to]) => message.split(from).join(to), error.message)
        }
        stats.base_scan_ms = Math.round(performance.now() - started)
      }
    }

    const selected = checkFindings.flatMap(finding => {
      if (isAddedLine(diff.added, finding.file, finding.line)) return [{ ...finding, changed: { reason: 'added-line' } }]
      const file = isBad(finding) ? affected.get(path.resolve(finding.file)) : null
      if (!file) return []
      const newlyActionable = base => [{ ...finding, changed: { reason: 'newly-actionable', inputs: [...file.inputs], base } }]
      if (file.baseRelative === null) return newlyActionable(null)
      if (unavailable !== null) return [{ ...finding, changed: { reason: 'base-unavailable', message: unavailable } }]
      const baseLine = baseLineFor(file.hunks, finding.line)
      if (baseLine === null || incomplete.has(file.baseRelative)) return newlyActionable(null)
      const match = baseFindings.get(findingKey(file.baseRelative, baseLine, finding.id, finding.matched))?.[occurrences.get(finding)]
      if (!match) return newlyActionable(null)
      if (isBad(match) && inCheckScope(match)) return []
      return newlyActionable(baseSummary(match))
    })
    return { findings: selected, stats }
  } finally {
    if (tempRoot !== null) fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}
