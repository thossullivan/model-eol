const ANSI = Object.freeze({
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
})

export const colorEnabled = (env = process.env, stdout = process.stdout) =>
  env.NO_COLOR === undefined && (Boolean(stdout?.isTTY) || env.FORCE_COLOR !== undefined)

export const color = (style, value, { env = process.env, stdout = process.stdout } = {}) => {
  const text = String(value)
  const code = ANSI[style]
  return code && colorEnabled(env, stdout) ? `${code}${text}${ANSI.reset}` : text
}
