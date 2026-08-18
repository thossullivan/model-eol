import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { TextDecoder } from 'node:util'

import { buildModelPattern } from './feeds.mjs'
import { matchesAnyGlob, matchesGlob, normalizeRepoPath } from './glob.mjs'

export const CODE_EXT = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.cxx', '.go', '.h', '.hpp', '.java', '.js',
  '.jsx', '.kt', '.kts', '.m', '.mjs', '.mm', '.php', '.py', '.rb', '.rs',
  '.scala', '.sh', '.swift', '.ts', '.tsx',
  '.baml', '.cfg', '.env', '.ini', '.json', '.toml', '.yaml', '.yml',
  '.sql', '.tf', '.tfvars',
])
export const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst'])
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', '.astro', '.worktrees', '.mypy_cache', '.ruff_cache', '.pytest_cache',
  '.tox', '.terraform', 'target', 'vendor', 'coverage', 'logs', 'tmp',
])
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_FILES = 100_000
export const INCOMPLETE_SCAN_REASONS = new Set([
  'file-too-large',
  'unreadable-file',
  'unreadable-path',
  'unreadable-directory',
  'invalid-utf8',
  'symlink-skipped',
  'submodule-skipped',
  'nested-repository-skipped',
  'file-count-cap',
  'git-listing-failure',
])

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const incompleteScanNotes = notes => notes.filter(note => INCOMPLETE_SCAN_REASONS.has(note.reason))

export const scanIsIncomplete = notes => incompleteScanNotes(notes).length > 0

const directSignals = [
  ['openai', /\b(OPENAI_API_KEY|api\.openai\.com|from\s+openai\s+import|import\s+OpenAI\s+from\s+['"]openai['"]|require\(['"]openai['"]\)|new\s+OpenAI\s*\(|provider\s+['"]?openai\b)/i, 'OpenAI direct SDK/API or BAML provider'],
  ['anthropic', /\b(ANTHROPIC_API_KEY|api\.anthropic\.com|@anthropic-ai\/sdk|from\s+anthropic\s+import|import\s+Anthropic\s+from\s+['"]@anthropic-ai\/sdk['"]|new\s+Anthropic\s*\(|provider\s+['"]?anthropic\b)/i, 'Anthropic direct SDK/API or BAML provider'],
  ['google-gemini', /\b(GEMINI_API_KEY|GOOGLE_API_KEY|generativelanguage\.googleapis\.com|@google\/genai|google-generativeai|GoogleGenerativeAI|provider\s+['"]?google-ai\b)\b/i, 'Gemini direct SDK/API or BAML provider'],
  ['mistral', /\b(MISTRAL_API_KEY|api\.mistral\.ai|@mistralai\/mistralai|from\s+mistralai\s+import|MistralClient|provider\s+['"]?mistral\b)\b/i, 'Mistral direct SDK/API or BAML provider'],
  ['cohere', /\b(COHERE_API_KEY|api\.cohere\.ai|from\s+cohere\s+import|new\s+CohereClient\s*\(|provider\s+['"]?cohere\b)/i, 'Cohere direct SDK/API or BAML provider'],
  ['xai', /\b(XAI_API_KEY|api\.x\.ai|provider\s+['"]?xai\b)\b/i, 'xAI direct SDK/API or BAML provider'],
]

const cloudSignals = [
  ['azure-ai-foundry', /\b(AZURE_OPENAI|AzureOpenAI|@azure\/openai|azure\.ai\.openai|azure-ai-foundry|AZURE_AI|provider\s+['"]?azure-openai\b)\b/i, 'Azure Foundry/OpenAI deployment reference'],
  ['aws-bedrock', /\b(BEDROCK_MODEL_ID|bedrock-runtime|BedrockRuntime|InvokeModel|invoke_model|amazon\.bedrock|provider\s+['"]?aws-bedrock\b)\b/i, 'Amazon Bedrock reference'],
  ['vertex-ai', /\b(VERTEX_AI|GOOGLE_CLOUD_PROJECT|aiplatform|vertexai|VertexAI|PredictionServiceClient|publishers\/google\/models|provider\s+['"]?vertex-ai\b)\b/i, 'Vertex AI reference'],
]

const gatewaySignals = [
  ['openrouter', /\b(OPENROUTER_API_KEY|openrouter\.ai|openrouter\/|provider\s+['"]?openrouter\b)\b/i, 'OpenRouter gateway reference'],
  ['litellm', /\b(LITELLM|litellm|LiteLLM|provider\s+['"]?litellm\b)\b/, 'LiteLLM gateway reference'],
  ['portkey', /\b(PORTKEY_API_KEY|portkey|Portkey|provider\s+['"]?portkey\b)\b/, 'Portkey gateway reference'],
  ['ai-gateway', /\b(AI_GATEWAY|Vercel AI Gateway|ai-gateway|provider\s+['"]?ai-gateway\b)\b/i, 'AI gateway reference'],
]

const allSignals = [
  ...directSignals.map(([provider, pattern, evidence]) => ({ usage: 'direct-api', provider, pattern, evidence })),
  ...cloudSignals.map(([provider, pattern, evidence]) => ({ usage: 'cloud-provider', provider, pattern, evidence })),
  ...gatewaySignals.map(([provider, pattern, evidence]) => ({ usage: 'gateway', provider, pattern, evidence })),
]

const findSignals = text => allSignals.flatMap(signal => {
  const m = text.match(signal.pattern)
  return m ? [{ ...signal, matched: m[0] }] : []
})

const candidatePatterns = [
  /\b(?:model|model_id|modelId|modelName|engine|deployment|deployment_name)\b\s*[:=]\s*["']([^"']{4,120})["']/gi,
  /["']((?:openai|anthropic|google|mistral|cohere|xai|amazon|meta-llama|deepseek|qwen)[\/.:][A-Za-z0-9._:/-]{4,120})["']/gi,
  /["']((?:gpt|o[1345]|claude|gemini|mistral|command|grok|llama|deepseek|qwen|nova|embed)[A-Za-z0-9._:/-]{4,120})["']/gi,
]

const obviousCandidateNoise = value =>
  /^[A-Z][A-Z0-9_]+$/.test(value) ||
  /^commands?_[a-z0-9_]+$/i.test(value) ||
  /^claude_code[._]/i.test(value) ||
  /\.(?:md|mdx|json|ya?ml|toml|txt|rst)$/i.test(value) ||
  /\.(?:token|cost)\.usage$/i.test(value)

const suffixes = value => {
  const parts = value.split(/[\/.:]/).filter(Boolean)
  return parts.flatMap((_, i) => [parts.slice(i).join('/'), parts.slice(i).join('.'), parts.slice(i).join(':')])
}

const isKnownModel = (value, entries) =>
  entries.has(value) || suffixes(value).some(v => entries.has(v))

const findCandidates = (lineText, entries) => {
  const seen = new Set()
  const candidates = []
  for (const pattern of candidatePatterns) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(lineText)) !== null) {
      const value = m[1].trim()
      if (seen.has(value)) continue
      seen.add(value)
      candidates.push(value)
    }
  }
  return candidates
}

const publisherForProvider = provider => provider === 'google-gemini' ? 'google' : provider

const providerMatchesPublisher = (provider, publisher) => publisherForProvider(provider) === publisher

const classifyRef = ({ file, line, lines, publisher }) => {
  const start = Math.max(0, line - 8)
  const end = Math.min(lines.length, line + 4)
  const signals = []
  for (let i = start; i < end; i++) {
    for (const signal of findSignals(lines[i])) {
      signals.push({ ...signal, distance: Math.abs((i + 1) - line) })
    }
  }
  signals.sort((a, b) => a.distance - b.distance)
  const nearest = signals[0]
  if (nearest) {
    const hasCompetingRoute = signals.some(signal => signal.usage === 'cloud-provider' || signal.usage === 'gateway')
    const providerMatches = nearest.usage !== 'direct-api' || providerMatchesPublisher(nearest.provider, publisher)
    const confidence = nearest.usage === 'direct-api' && !hasCompetingRoute && providerMatches ? 'high' : 'medium'
    const evidence = providerMatches
      ? nearest.evidence
      : `${nearest.evidence}; signal provider ${nearest.provider} differs from model publisher ${publisher}`
    return { usage: nearest.usage, provider: nearest.provider, confidence, evidence }
  }

  const lowerFile = file.toLowerCase()
  if (lowerFile.includes('azure')) return { usage: 'cloud-provider', provider: 'azure-ai-foundry', confidence: 'low', evidence: 'azure-like file path' }
  if (lowerFile.includes('bedrock')) return { usage: 'cloud-provider', provider: 'aws-bedrock', confidence: 'low', evidence: 'bedrock-like file path' }
  if (lowerFile.includes('vertex')) return { usage: 'cloud-provider', provider: 'vertex-ai', confidence: 'low', evidence: 'vertex-like file path' }

  return { usage: 'model-reference', provider: publisher, confidence: 'medium', evidence: 'tracked model ID or alias' }
}

const isScannable = (file, includeDocs) => {
  const basename = path.basename(file)
  if (basename === '.model-eol.json') return false
  if (basename === '.env' || basename.startsWith('.env.')) return true
  const ext = path.extname(file)
  return CODE_EXT.has(ext) || (includeDocs && DOC_EXT.has(ext))
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const displayPath = absolute => {
  const relative = path.relative(process.cwd(), absolute)
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    ? relative
    : absolute
}

export const gitRootFor = target => {
  const cwd = fs.lstatSync(target).isDirectory() ? target : path.dirname(target)
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error || result.status !== 0) return null
  const root = result.stdout.trim()
  return root ? fs.realpathSync(path.resolve(root)) : null
}

const changedKey = (file, line) => `${path.resolve(file)}:${line}`

const gitPathEscapes = new Map([
  ['a', 0x07],
  ['b', 0x08],
  ['t', 0x09],
  ['n', 0x0a],
  ['v', 0x0b],
  ['f', 0x0c],
  ['r', 0x0d],
  ['\\', 0x5c],
  ['"', 0x22],
])

const decodeGitQuotedPath = raw => {
  if (!raw.endsWith('"')) throw new Error(`malformed quoted Git diff path: ${raw}`)
  const bytes = []
  let literalStart = 1
  const appendLiteral = end => {
    if (end > literalStart) bytes.push(...Buffer.from(raw.slice(literalStart, end), 'utf8'))
  }
  for (let index = 1; index < raw.length - 1; index++) {
    const character = raw[index]
    if (character === '"') throw new Error(`malformed quoted Git diff path: ${raw}`)
    if (character !== '\\') continue
    appendLiteral(index)
    index++
    if (index >= raw.length - 1) throw new Error(`malformed quoted Git diff path: ${raw}`)
    const escaped = raw[index]
    if (/[0-7]/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && index + 1 < raw.length - 1 && /[0-7]/.test(raw[index + 1])) {
        octal += raw[++index]
      }
      const value = Number.parseInt(octal, 8)
      if (value > 0xff) throw new Error(`invalid octal escape in Git diff path: ${raw}`)
      bytes.push(value)
    } else if (gitPathEscapes.has(escaped)) {
      bytes.push(gitPathEscapes.get(escaped))
    } else {
      throw new Error(`unsupported escape in Git diff path: ${raw}`)
    }
    literalStart = index + 1
  }
  appendLiteral(raw.length - 1)
  let decoded
  try {
    decoded = utf8Decoder.decode(Buffer.from(bytes))
  } catch {
    throw new Error(`Git diff path is not valid UTF-8: ${raw}`)
  }
  if (decoded.includes('\0')) throw new Error(`Git diff path contains a NUL byte: ${raw}`)
  return decoded
}

export const parseDiffPath = value => {
  const raw = value.endsWith('\r') ? value.slice(0, -1) : value
  const decoded = raw.startsWith('"') ? decodeGitQuotedPath(raw) : raw
  if (decoded === '/dev/null') return null
  return decoded.startsWith('b/') ? decoded.slice(2) : decoded
}

export const addedLinesForTargets = (targets, baseRef) => {
  if (!baseRef) throw new Error('--changed requires a base ref')
  const roots = new Set()
  const resolvedTargets = []
  for (const target of targets) {
    let resolvedTarget
    try {
      resolvedTarget = fs.realpathSync(path.resolve(target))
    } catch {
      resolvedTarget = null
    }
    let root
    try {
      root = resolvedTarget ? gitRootFor(resolvedTarget) : null
    } catch {
      root = null
    }
    if (!root) throw new Error(`--changed requires a git repository for target ${target}`)
    roots.add(root)
    resolvedTargets.push({ target, path: resolvedTarget })
  }
  if (roots.size !== 1) throw new Error('--changed targets must belong to the same git repository')
  const gitRoot = [...roots][0]
  const relativeTargets = resolvedTargets.map(({ target, path: resolvedTarget }) => {
    const relative = path.relative(gitRoot, resolvedTarget)
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`--changed target is outside its git root: ${target}`)
    }
    return relative || '.'
  })
  if (baseRef.startsWith('-')) {
    throw new Error(`--changed base ref must not begin with "-": ${JSON.stringify(baseRef)}`)
  }
  const resolvedBase = spawnSync('git', [
    'rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`,
  ], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const baseCommit = (resolvedBase.stdout ?? '').trim()
  if (resolvedBase.error || resolvedBase.status !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
    const detail = (resolvedBase.stderr ?? '').trim()
    throw new Error(`--changed could not resolve base ref "${baseRef}" to a commit${detail ? `: ${detail}` : ''}`)
  }
  const result = spawnSync('git', [
    '-c', 'core.quotePath=true',
    'diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
    '--text', '--no-ext-diff', '--no-textconv', '--unified=0', baseCommit, '--', ...relativeTargets,
  ], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? '').trim()
    throw new Error(`--changed git diff failed for base ref "${baseRef}"${detail ? `: ${detail}` : ''}`)
  }

  const added = new Set()
  let file = null
  let inHunk = false
  let newLine = 0
  let newLinesRemaining = 0
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null
      inHunk = false
      newLinesRemaining = 0
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const relative = parseDiffPath(line.slice(4))
      file = relative ? path.resolve(gitRoot, relative) : null
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      inHunk = true
      newLine = Number(hunk[1])
      newLinesRemaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      continue
    }
    // Unified-diff metadata such as "\\ No newline at end of file" does not
    // consume a line on either side of the hunk.
    if (line.startsWith('\\ ')) continue
    if (!inHunk || !file || newLinesRemaining === 0) continue
    if (line.startsWith('+')) added.add(changedKey(file, newLine))
    if (!line.startsWith('-')) {
      newLine++
      newLinesRemaining--
    }
  }
  return added
}

export const filterFindingsToChanged = (findings, addedLines) =>
  findings.filter(finding => addedLines.has(changedKey(finding.file, finding.line)))

const collectFilesDetailed = (targets, {
  includeDocs = false,
  ignorePaths = [],
  ignoreRoots = [],
  ignoredFiles = [],
  policyForFile = null,
} = {}) => {
  const files = []
  const notes = []
  const validTargets = []
  const seen = new Set()
  const canonicalPath = value => {
    const resolved = path.resolve(value)
    try {
      return fs.realpathSync(resolved)
    } catch {
      return resolved
    }
  }
  const excludedFiles = new Set(ignoredFiles.map(canonicalPath))
  const roots = [...new Set(ignoreRoots.flatMap(root => [path.resolve(root), canonicalPath(root)]))]
  let fileLimitWarned = false
  let stopped = false

  const note = value => notes.push(value)
  const repoPathsFor = absolute => {
    const candidates = [...new Set([path.resolve(absolute), canonicalPath(absolute)])]
    const repoPaths = new Set()
    for (const candidate of candidates) {
      for (const root of roots) {
        const relative = path.relative(root, candidate)
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
        repoPaths.add(normalizeRepoPath(relative))
      }
    }
    return [...repoPaths]
  }
  const matchesIgnoredRepoPath = repoPath => matchesAnyGlob(repoPath, ignorePaths) ||
    ignorePaths.some(pattern => {
      const normalizedPattern = normalizeRepoPath(pattern).replace(/\/+$/, '')
      return normalizedPattern && !/[*?]/.test(normalizedPattern) && repoPath.startsWith(`${normalizedPattern}/`)
    })
  const isIgnoredFile = absolute => {
    const resolved = canonicalPath(absolute)
    if (excludedFiles.has(resolved) || repoPathsFor(absolute).some(matchesIgnoredRepoPath)) return true
    const policyPaths = [...new Set([path.resolve(absolute), resolved])]
    return policyPaths.some(candidate => {
      const policy = policyForFile?.(candidate)
      return Boolean(policy?.repoPath && matchesIgnoredRepoPathWithPatterns(policy.repoPath, policy.ignore?.paths ?? []))
    })
  }
  const matchesIgnoredRepoPathWithPatterns = (repoPath, patterns) => matchesAnyGlob(repoPath, patterns) ||
    patterns.some(pattern => {
      const normalizedPattern = normalizeRepoPath(pattern).replace(/\/+$/, '')
      return normalizedPattern && !/[*?]/.test(normalizedPattern) && repoPath.startsWith(`${normalizedPattern}/`)
    })
  const isIgnoredDirectoryTree = absolute => repoPathsFor(absolute).some(repoPath =>
    ignorePaths.some(pattern => {
      const normalizedPattern = normalizeRepoPath(pattern)
      const literalDirectory = !/[*?]/.test(normalizedPattern) && normalizedPattern.replace(/\/+$/, '') === repoPath
      const subtreeGlob = normalizedPattern.endsWith('/**') && matchesGlob(repoPath, normalizedPattern.slice(0, -3))
      return literalDirectory || subtreeGlob
    }))
  const addFile = absolute => {
    if (stopped || seen.has(absolute) || isIgnoredFile(absolute)) return
    seen.add(absolute)

    let st
    try {
      st = fs.lstatSync(absolute)
    } catch (e) {
      note({ reason: 'unreadable-file', file: displayPath(absolute), message: e.message })
      return
    }
    if (st.isSymbolicLink()) {
      if (!isIgnoredFile(absolute)) note({ reason: 'symlink-skipped', file: displayPath(absolute) })
      return
    }
    if (!st.isFile() || !isScannable(absolute, includeDocs)) return
    if (st.size > MAX_FILE_BYTES) {
      note({
        reason: 'file-too-large',
        file: displayPath(absolute),
        bytes: st.size,
        limit_bytes: MAX_FILE_BYTES,
      })
      return
    }
    if (files.length >= MAX_FILES) {
      stopped = true
      if (!fileLimitWarned) {
        note({
          reason: 'file-count-cap',
          file: displayPath(absolute),
          limit_files: MAX_FILES,
          message: `file-count cap (${MAX_FILES}) reached; remaining files skipped`,
        })
        fileLimitWarned = true
      }
      return
    }
    files.push(displayPath(absolute))
  }

  const walk = absolute => {
    if (stopped || excludedFiles.has(canonicalPath(absolute))) return
    let st
    try {
      st = fs.lstatSync(absolute)
    } catch (e) {
      note({ reason: 'unreadable-path', file: displayPath(absolute), message: e.message })
      return
    }
    if (st.isSymbolicLink()) {
      if (!isIgnoredFile(absolute)) note({ reason: 'symlink-skipped', file: displayPath(absolute) })
      return
    }
    if (!st.isDirectory()) {
      addFile(absolute)
      return
    }
    if (isIgnoredDirectoryTree(absolute)) return
    if (SKIP_DIRS.has(path.basename(absolute))) return
    let names
    try {
      names = fs.readdirSync(absolute)
    } catch (e) {
      note({ reason: 'unreadable-directory', file: displayPath(absolute), message: e.message })
      return
    }
    for (const name of names) {
      walk(path.join(absolute, name))
      if (stopped) return
    }
  }

  const listGitFiles = (absoluteTarget, gitRoot) => {
    const relativeTarget = path.relative(gitRoot, absoluteTarget) || '.'
    const result = spawnSync('git', [
      'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relativeTarget,
    ], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
      note({
        reason: 'git-listing-failure',
        file: displayPath(absoluteTarget),
        message: `git file listing failed: ${detail}; no recursive fallback used`,
      })
      return
    }
    const tracked = spawnSync('git', [
      'ls-files', '-z', '--cached', '--stage', '--', relativeTarget,
    ], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (tracked.error || tracked.status !== 0) {
      const detail = tracked.error?.message || tracked.stderr?.trim() || `exit ${tracked.status}`
      note({
        reason: 'git-listing-failure',
        file: displayPath(absoluteTarget),
        message: `git index metadata listing failed: ${detail}; no recursive fallback used`,
      })
      return
    }
    const gitlinks = new Set()
    for (const record of tracked.stdout.split('\0')) {
      if (!record) continue
      const separator = record.indexOf('\t')
      const metadata = separator === -1 ? '' : record.slice(0, separator)
      const relativeFile = separator === -1 ? '' : record.slice(separator + 1)
      if (!/^[0-7]{6} [0-9a-f]+ [0-3]$/.test(metadata) || !relativeFile) {
        note({
          reason: 'git-listing-failure',
          file: displayPath(absoluteTarget),
          message: 'git index metadata listing returned a malformed record; no recursive fallback used',
        })
        return
      }
      if (metadata.startsWith('160000 ')) gitlinks.add(relativeFile)
    }
    for (const relativeFile of result.stdout.split('\0')) {
      if (stopped) break
      if (!relativeFile) continue
      const absoluteFile = path.resolve(gitRoot, relativeFile)
      if (gitlinks.has(relativeFile)) {
        if (!isIgnoredFile(absoluteFile)) note({ reason: 'submodule-skipped', file: displayPath(absoluteFile) })
        continue
      }
      if (relativeFile.endsWith('/')) {
        if (!isIgnoredFile(absoluteFile)) note({ reason: 'nested-repository-skipped', file: displayPath(absoluteFile) })
        continue
      }
      if (path.relative(gitRoot, absoluteFile).split(path.sep).some(part => SKIP_DIRS.has(part))) continue
      addFile(absoluteFile)
    }
  }

  for (const target of targets) {
    const absoluteTarget = path.resolve(target)
    let st
    try {
      st = fs.lstatSync(absoluteTarget)
    } catch (e) {
      console.error(`model-eol: warning: target not found, skipping ${target}`)
      continue
    }
    validTargets.push(absoluteTarget)
    if (st.isSymbolicLink()) {
      note({ reason: 'symlink-skipped', file: displayPath(absoluteTarget) })
      continue
    }

    let resolvedTarget
    try {
      resolvedTarget = fs.realpathSync(absoluteTarget)
    } catch {
      resolvedTarget = absoluteTarget
    }
    const gitRoot = gitRootFor(resolvedTarget)
    if (gitRoot) listGitFiles(resolvedTarget, gitRoot)
    else walk(absoluteTarget)
  }

  return { files, notes, validTargets }
}

export const collectFiles = (targets, options = {}) => collectFilesDetailed(targets, options).files

export const scanTargets = ({
  targets,
  entries,
  keys,
  includeDocs = false,
  ignoreModels = [],
  ignorePaths = [],
  ignoreRoots = [],
  ignoredFiles = [],
  policyForFile = null,
  routeForReference = null,
  mappedRoutesForFile = null,
}) => {
  const collected = collectFilesDetailed(targets, { includeDocs, ignorePaths, ignoreRoots, ignoredFiles, policyForFile })
  if (collected.validTargets.length === 0) throw new Error('no valid targets remain')
  const { files } = collected
  const pattern = buildModelPattern(keys)
  const ignoredSets = models => ({
    keys: new Set(models),
    canonicalIds: new Set(models.map(key => entries.get(key)?.entry.id ?? key)),
  })
  const baseIgnored = ignoredSets(ignoreModels)
  const ignoresModel = (file, matched, id = null) => {
    const configured = policyForFile?.(path.resolve(file))?.ignore?.models ?? []
    const dynamicIgnored = configured.length ? ignoredSets(configured) : null
    return baseIgnored.keys.has(matched) || (id !== null && baseIgnored.canonicalIds.has(id)) ||
      dynamicIgnored?.keys.has(matched) || (id !== null && dynamicIgnored?.canonicalIds.has(id))
  }
  const modelRefs = []
  const candidateRefs = []
  const integrationHints = []

  const modelEolDocument = (file, text) => {
    if (!file.endsWith('.json')) return false
    try {
      const value = JSON.parse(text)
      const productSchema = [value?.spec, value?.schema, value?.plan_schema]
        .some(identifier => typeof identifier === 'string' && (identifier.startsWith('model-eol/') || identifier.startsWith('model-eol.')))
      const generatedCycloneDx = value?.bomFormat === 'CycloneDX' &&
        value?.metadata?.properties?.some(property =>
          property?.name === 'model-eol:generator' && property?.value === 'model-eol/inventory-cyclonedx@0.1')
      return productSchema || generatedCycloneDx
    } catch {
      return false
    }
  }

  const generatedSource = text => {
    const header = text.slice(0, 8192)
    return /This file was generated by BAML/i.test(header) ||
      /Code generated .* DO NOT EDIT/i.test(header) ||
      /^\s*(?:[/#*;-]+\s*)?@generated\b/im.test(header) ||
      /AUTO[- ]GENERATED FILE[\s\S]{0,240}DO NOT EDIT/i.test(header)
  }

  const routeClassification = route => {
    const usage = cloudSignals.some(([provider]) => provider === route.via)
      ? 'cloud-provider'
      : gatewaySignals.some(([provider]) => provider === route.via)
        ? 'gateway'
        : 'model-reference'
    return {
      usage,
      provider: route.via,
      confidence: 'high',
      evidence: `configured route ${route.index} via ${route.via}`,
    }
  }

  const pushModelRef = ({ file, line, lineText, matchIndex = null, matched, record, classification, route = null, mappedFrom = null }) => {
    if (ignoresModel(file, matched, record.entry.id) || (mappedFrom && ignoresModel(file, mappedFrom, record.entry.id))) return
    const occurrence = [...lineText.matchAll(new RegExp(escapeRegExp(matched), 'g'))]
      .findIndex(match => match.index === (matchIndex ?? lineText.indexOf(matched)))
    modelRefs.push({
      kind: 'model-reference',
      file,
      line,
      matched,
      id: record.entry.id,
      entry: record.entry,
      publisher: record.publisher,
      source: record.source,
      feedNote: record.feedNote,
      policy: record.policy,
      generated: record.generated,
      usage: classification.usage,
      resolved_provider: classification.provider,
      confidence: classification.confidence,
      evidence: classification.evidence,
      occurrence: occurrence < 0 ? 0 : occurrence,
      route_index: route?.index ?? null,
      mapped_from: mappedFrom,
    })
  }

  for (const file of files) {
    let bytes
    try {
      bytes = fs.readFileSync(file)
    } catch (e) {
      collected.notes.push({ reason: 'unreadable-file', file, message: e.message })
      continue
    }
    let text
    try {
      text = utf8Decoder.decode(bytes)
    } catch (e) {
      collected.notes.push({ reason: 'invalid-utf8', file, message: e.message })
      continue
    }
    // Product artifacts and generated clients describe model IDs but are not
    // authoritative usage or safe migration targets.
    if (modelEolDocument(file, text)) {
      collected.notes.push({ reason: 'model-eol-document-skipped', file })
      continue
    }
    if (generatedSource(text)) {
      collected.notes.push({ reason: 'generated-artifact-skipped', file })
      continue
    }
    const lines = text.split('\n')
    for (const [i, lineText] of lines.entries()) {
      const signals = findSignals(lineText)
      const candidates = findCandidates(lineText, entries)
      const mappedSources = new Set()
      const mappedSpans = []
      const resolvedProviders = new Set()
      const selectedMappings = new Map()
      for (const configuredRoute of mappedRoutesForFile?.(file) ?? []) {
        const route = routeForReference?.({ file, matched: configuredRoute.match, id: null }) ?? null
        if (!route?.model) continue
        selectedMappings.set(`${route.index}:${route.match}`, route)
      }
      for (const route of selectedMappings.values()) {
        const record = entries.get(route.model)
        if (!record) continue
        const exactRoutePattern = new RegExp(`(?<![A-Za-z0-9._:/-])${escapeRegExp(route.match)}(?![A-Za-z0-9._:/-])`, 'g')
        for (const match of lineText.matchAll(exactRoutePattern)) {
          mappedSources.add(route.match)
          mappedSpans.push({ start: match.index, end: match.index + route.match.length })
          resolvedProviders.add(route.via)
          pushModelRef({
            file,
            line: i + 1,
            lineText,
            matchIndex: match.index,
            matched: route.match,
            record,
            classification: routeClassification(route),
            route,
            mappedFrom: route.match,
          })
        }
      }

      if (pattern) {
        pattern.lastIndex = 0
        let m
        while ((m = pattern.exec(lineText)) !== null) {
          if (mappedSpans.some(span => m.index >= span.start && m.index + m[1].length <= span.end)) continue
          const record = entries.get(m[1])
          const route = routeForReference?.({ file, matched: m[1], id: record.entry.id }) ?? null
          const classification = route ? routeClassification(route) : classifyRef({
            file,
            line: i + 1,
            lines,
            publisher: record.publisher,
          })
          if (route) resolvedProviders.add(route.via)
          pushModelRef({
            file,
            line: i + 1,
            lineText,
            matchIndex: m.index,
            matched: m[1],
            record,
            classification,
            route,
          })
        }
      }

      for (const candidate of candidates) {
        if (mappedSources.has(candidate) || isKnownModel(candidate, entries) || obviousCandidateNoise(candidate)) continue
        if (ignoresModel(file, candidate)) continue
        const classification = classifyRef({
          file,
          line: i + 1,
          lines,
          publisher: 'unknown',
        })
        candidateRefs.push({
          kind: 'candidate-model-reference',
          file,
          line: i + 1,
          matched: candidate,
          usage: classification.usage,
          resolved_provider: classification.provider,
          confidence: classification.confidence === 'high' ? 'medium' : 'low',
          evidence: classification.evidence,
          reason: 'model-like string not present in loaded feeds',
        })
      }
      for (const signal of signals) {
        if (resolvedProviders.has(signal.provider)) continue
        integrationHints.push({
          kind: 'integration-hint',
          usage: signal.usage,
          provider: signal.provider,
          file,
          line: i + 1,
          matched: signal.matched,
          evidence: signal.evidence,
        })
      }
    }
  }

  return { files, modelRefs, candidateRefs, integrationHints, notes: collected.notes, validTargets: collected.validTargets }
}
