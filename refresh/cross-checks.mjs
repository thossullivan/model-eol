/** True when MODEL_EOL_CROSS_CHECKS=strict makes a failed cross-check fail the run; unset, empty, or warn reports it and goes on. */
export function strictCrossChecks(env = process.env) {
  const value = env.MODEL_EOL_CROSS_CHECKS ?? ''
  if (!['', 'warn', 'strict'].includes(value)) throw new Error(`MODEL_EOL_CROSS_CHECKS must be unset, "warn", or "strict", not ${JSON.stringify(value)}`)
  return value === 'strict'
}
