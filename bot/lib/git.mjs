import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const BOT_IDENTITY_EMAIL = 'model-eol[bot]@users.noreply.github.com'

const run = (cwd, args, allowFailure = false) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!result.error && result.status === 0) return result.stdout.trim()
  if (allowFailure) return null
  const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
  throw new Error(`git ${args.join(' ')} failed: ${detail}`)
}

export const git = run

export const originFor = targetDir =>
  run(targetDir, ['remote', 'get-url', 'origin'], true) || targetDir

export const cloneRepository = (source, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  run(null, ['clone', '--quiet', source, destination])
  return destination
}

export const defaultBranch = cwd => {
  const remoteHead = run(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], true)
  if (remoteHead?.startsWith('origin/')) return remoteHead.slice('origin/'.length)
  const current = run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
  if (current) return current
  const remoteShow = run(cwd, ['remote', 'show', 'origin'], true)
  const match = remoteShow?.match(/HEAD branch:\s*(\S+)/)
  if (match) return match[1]
  return 'main'
}

export const prepareBranch = (cwd, branch, base) => {
  run(cwd, ['fetch', 'origin', '--prune'])
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

export const verifyBotBranch = (cwd, branch, expectedHead) => {
  try {
    run(cwd, ['fetch', 'origin', '--prune'])
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

export const pushBranch = (cwd, branch, expectedHead = null) => {
  const destination = `HEAD:refs/heads/${branch}`
  if (expectedHead !== null) {
    const state = verifyBotBranch(cwd, branch, expectedHead)
    if (!state.safe) {
      const error = new Error(state.error || `refusing force-push: branch head ${state.head || 'missing'} or committer email ${state.committerEmail || 'missing'} failed bot lease checks`)
      error.code = 'MODEL_EOL_BRANCH_STAND_DOWN'
      error.currentHead = state.head
      error.committerEmail = state.committerEmail
      throw error
    }
    run(cwd, [
      'push',
      `--force-with-lease=refs/heads/${branch}:${expectedHead}`,
      'origin',
      destination,
    ])
  } else {
    run(cwd, ['push', 'origin', destination])
  }
}
