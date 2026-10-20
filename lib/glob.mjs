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

const compiledGlobs = new Map()
const compiledGlob = pattern => {
  if (!compiledGlobs.has(pattern)) compiledGlobs.set(pattern, globRegex(pattern))
  return compiledGlobs.get(pattern)
}

export const matchesGlob = (file, pattern) => compiledGlob(pattern).test(normalizeRepoPath(file))

export const matchesAnyGlob = (file, patterns = []) => {
  const normalized = normalizeRepoPath(file)
  return patterns.some(pattern => compiledGlob(pattern).test(normalized))
}
