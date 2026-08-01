import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const truncateReport = (value, limit) => {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= limit) return value
  const marker = Buffer.from('\n[model-eol: report truncated]', 'utf8')
  if (limit <= marker.length) return marker.subarray(0, limit).toString('utf8')
  return Buffer.concat([bytes.subarray(0, limit - marker.length), marker]).toString('utf8')
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
  })
  const timedOut = result.error?.code === 'ETIMEDOUT'
    || result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  const exitCode = Number.isInteger(result.status) ? result.status : null
  const status = timedOut ? 'timeout' : exitCode === 0 ? 'pass' : 'fail'
  let report = null
  if (fs.existsSync(reportPath)) {
    report = truncateReport(fs.readFileSync(reportPath, 'utf8'), maxReportBytes)
  }
  return { status, exit_code: exitCode, report }
}

export const reportForBody = report => String(report ?? '').replaceAll('`', '')
