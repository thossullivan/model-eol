import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const BOT_IDENTITY_EMAIL = 'model-eol[bot]@users.noreply.github.com'

const environmentFor = auth => auth
  ? {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: auth.key,
      GIT_CONFIG_VALUE_0: auth.value,
      GIT_TERMINAL_PROMPT: '0',
      GIT_TRACE_REDACT: '1',
    }
  : process.env

const run = (cwd, args, allowFailure = false, auth = null) => {
  const result = spawnSync('git', args, {
    cwd,
    env: environmentFor(auth),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!result.error && result.status === 0) return result.stdout.trim()
  if (allowFailure) return null
  const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
  throw new Error(`git ${args.join(' ')} failed: ${detail}`)
}

export const git = run

export const gitAuthentication = (source, token, apiUrl = 'https://api.github.com') => {
  if (!token) return null
  let url
  let api
  try {
    url = new URL(source)
    api = new URL(apiUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const expectedHost = api.host === 'api.github.com' ? 'github.com' : api.host
  if (api.protocol !== 'https:' || url.host !== expectedHost) return null
  const scope = `${url.protocol}//${url.host}/`
  const credential = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    key: `http.${scope}.extraheader`,
    value: `AUTHORIZATION: basic ${credential}`,
  }
}

export const originFor = targetDir =>
  run(targetDir, ['remote', 'get-url', 'origin'], true) || targetDir

export const cloneRepository = (source, destination, auth = null) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  run(null, ['clone', '--quiet', '--', source, destination], false, auth)
  return destination
}

export const defaultBranch = (cwd, auth = null) => {
  const remoteHead = run(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], true)
  if (remoteHead?.startsWith('origin/')) return remoteHead.slice('origin/'.length)
  const current = run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
  if (current) return current
  const remoteShow = run(cwd, ['remote', 'show', 'origin'], true, auth)
  const match = remoteShow?.match(/HEAD branch:\s*(\S+)/)
  if (match) return match[1]
  return 'main'
}

export const prepareBranch = (cwd, branch, base, auth = null) => {
  run(cwd, ['fetch', 'origin', '--prune'], false, auth)
  const remoteBase = run(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${base}`], true)
  run(cwd, ['checkout', '-B', branch, remoteBase ? `origin/${base}` : base])
}

export const configureIdentity = cwd => {
  run(cwd, ['config', 'user.name', 'model-eol[bot]'])
  run(cwd, ['config', 'user.email', BOT_IDENTITY_EMAIL])
}

export const commitAll = (cwd, files, message) => {
  const unique = [...new Set(files)]
  if (unique.length) run(cwd, ['add', '--', ...unique])
  run(cwd, ['commit', '--allow-empty', '-m', message])
  return run(cwd, ['rev-parse', 'HEAD'])
}

export const verifyBotBranch = (cwd, branch, expectedHead, auth = null) => {
  try {
    run(cwd, ['fetch', 'origin', '--prune'], false, auth)
  } catch (error) {
    return { head: null, committerEmail: null, safe: false, error: error.message }
  }
  const head = run(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], true)
  const committerEmail = head ? run(cwd, ['show', '-s', '--format=%cE', head], true) : null
  return {
    head,
    committerEmail,
    safe: head === expectedHead && committerEmail === BOT_IDENTITY_EMAIL,
    error: null,
  }
}

export const verifyRemoteBranchHead = (cwd, branch, expectedHead, auth = null) => {
  try {
    run(cwd, ['fetch', 'origin', '--prune'], false, auth)
  } catch (error) {
    return { head: null, safe: false, error: error.message }
  }
  const head = run(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], true)
  return {
    head,
    safe: head === expectedHead,
    error: null,
  }
}

const exactObjectId = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)

const requireExactObjectId = (value, name) => {
  if (!exactObjectId(value)) throw new Error(`refusing remote branch mutation without an exact ${name} commit`)
}

export const isCommitAvailable = (cwd, head) => exactObjectId(head)
  && run(cwd, ['cat-file', '-e', `${head}^{commit}`], true) !== null

export const deleteRemoteBranch = (cwd, branch, expectedHead, auth = null) => {
  requireExactObjectId(expectedHead, 'expected')
  const ref = `refs/heads/${branch}`
  run(cwd, [
    'push',
    `--force-with-lease=${ref}:${expectedHead}`,
    'origin',
    `:${ref}`,
  ], false, auth)
}

export const restoreRemoteBranch = (cwd, branch, expectedCurrentHead, restoreHead, auth = null) => {
  requireExactObjectId(expectedCurrentHead, 'current')
  requireExactObjectId(restoreHead, 'restore')
  if (!isCommitAvailable(cwd, restoreHead)) {
    throw new Error(`refusing remote branch rollback because restore commit ${restoreHead} is unavailable`)
  }
  const ref = `refs/heads/${branch}`
  run(cwd, [
    'push',
    `--force-with-lease=${ref}:${expectedCurrentHead}`,
    'origin',
    `${restoreHead}:${ref}`,
  ], false, auth)
}

export const pushBranch = (cwd, branch, expectedHead = null, auth = null, { allowMissing = false } = {}) => {
  const destination = `HEAD:refs/heads/${branch}`
  if (expectedHead !== null) {
    const state = verifyBotBranch(cwd, branch, expectedHead, auth)
    if (!state.safe && !(allowMissing && !state.error && state.head === null)) {
      const error = new Error(state.error || `refusing force-push: branch head ${state.head || 'missing'} or committer email ${state.committerEmail || 'missing'} failed bot lease checks`)
      error.code = 'MODEL_EOL_BRANCH_STAND_DOWN'
      error.currentHead = state.head
      error.committerEmail = state.committerEmail
      throw error
    }
    if (state.head === null) run(cwd, ['push', 'origin', destination], false, auth)
    else {
      run(cwd, [
        'push',
        `--force-with-lease=refs/heads/${branch}:${expectedHead}`,
        'origin',
        destination,
      ], false, auth)
    }
  } else {
    run(cwd, ['push', 'origin', destination], false, auth)
  }
}
