import { parseArgs as nodeParseArgs } from 'node:util'

export class CliUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliUsageError'
    this.exitCode = 2
  }
}

const unknownOption = error => String(error?.message ?? '').match(/Unknown option '([^']+)'/)?.[1]

export const parseCliArgs = ({ args, options, allowPositionals = false, help }) => {
  try {
    return nodeParseArgs({ args, options, strict: true, allowPositionals })
  } catch (error) {
    const option = unknownOption(error)
    if (option) throw new CliUsageError(`unknown option ${option}; run ${help} for usage`)
    if (String(error?.code ?? '').startsWith('ERR_PARSE_ARGS_')) {
      const message = String(error.message).split('\n', 1)[0]
      throw new CliUsageError(`${message}; run ${help} for usage`)
    }
    throw error
  }
}
