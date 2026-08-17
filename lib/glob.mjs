const escapeRegExp = value => value.replace(/[.+^${}()|[\]\\]/g, '\\$&')

export const normalizeRepoPath = value => String(value ?? '')
  .replaceAll('\\', '/')
  .replace(/^\.\//, '')
  .replace(/^\/+/, '')

export const globRegex = pattern => {
  let source = ''
  const value = normalizeRepoPath(pattern)
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '*' && value[i + 1] === '*') {
      if (value[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i++
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`^${source}$`)
}

export const matchesGlob = (file, pattern) => globRegex(pattern).test(normalizeRepoPath(file))

export const matchesAnyGlob = (file, patterns = []) =>
  patterns.some(pattern => matchesGlob(file, pattern))
