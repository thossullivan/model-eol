import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { markdownFenceText } from './common.mjs'

const truncateReport = (bytes, limit, truncated) => {
  if (!truncated) return bytes.toString('utf8')
  const marker = Buffer.from('\n[model-eol: report truncated]', 'utf8')
  if (limit <= marker.length) return marker.subarray(0, limit).toString('utf8')
  return Buffer.concat([bytes.subarray(0, limit - marker.length), marker]).subarray(0, limit).toString('utf8')
}

export const readReportCapped = (file, limit) => {
  const cap = Math.max(0, limit)
  let lstat
  try {
    lstat = fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, report: null }
    throw error
  }
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw new Error(`${file} is not a regular non-symlink file`)
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, report: null }
    throw error
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular non-symlink file`)
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  try {
    const buffer = Buffer.alloc(cap + 1)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return {
      missing: false,
      report: truncateReport(buffer.subarray(0, Math.min(bytesRead, cap)), cap, bytesRead > cap),
    }
  } finally {
    fs.closeSync(fd)
  }
}

export const runEvalHook = ({ command, timeoutMs, maxReportBytes, passEnv = [], cwd, oldId, newId, planPath, reportPath }) => {
  if (fs.existsSync(reportPath)) fs.rmSync(reportPath, { force: true })
  const env = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'SHELL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of passEnv) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.MODEL_EOL_OLD_ID = oldId
  env.MODEL_EOL_NEW_ID = newId
  env.MODEL_EOL_PLAN = planPath
  env.MODEL_EOL_REPORT = reportPath

  const result = spawnSync(command, {
    cwd,
    env,
    shell: true,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })
  const timedOut = result.error?.code === 'ETIMEDOUT'
    || result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  if (timedOut && Number.isInteger(result.pid)) {
    try {
      process.kill(-result.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw new Error(`could not kill eval process group: ${error.message}`)
    }
  }
  const exitCode = Number.isInteger(result.status) ? result.status : null
  let status = timedOut ? 'timeout' : exitCode === 0 ? 'pass' : 'fail'
  let report = null
  try {
    const artifact = readReportCapped(reportPath, maxReportBytes)
    if (artifact.missing && status === 'pass') {
      status = 'fail'
      report = 'eval report artifact is missing'
    } else {
      report = artifact.report
    }
  } catch (error) {
    if (status === 'pass') status = 'fail'
    report = `eval report artifact is unreadable: ${error.message}`
  }
  return { status, exit_code: exitCode, report }
}

export const reportForBody = report => markdownFenceText(report)
