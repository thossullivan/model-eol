const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export const jsonChildPath = (parent, key) => {
  if (typeof key === 'number') return `${parent}[${key}]`
  if (IDENTIFIER_PATTERN.test(key)) return parent ? `${parent}.${key}` : key
  return `${parent}[${JSON.stringify(key)}]`
}

export const findDuplicateJsonKey = source => {
  const stack = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '"') {
      const start = i
      i++
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1
      i++
      const top = stack.at(-1)
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(source.slice(start, i))
        const at = jsonChildPath(top.path, key)
        if (top.keys.has(key)) return at
        top.keys.add(key)
        top.expectKey = false
        top.current = at
      }
      continue
    }
    if (c === '{' || c === '[') {
      const top = stack.at(-1)
      const at = !top ? '' : top.keys ? top.current : jsonChildPath(top.path, top.index)
      stack.push(c === '{' ? { keys: new Set(), expectKey: true, path: at } : { keys: null, index: 0, path: at })
    } else if (c === '}' || c === ']') {
      stack.pop()
    } else if (c === ',') {
      const top = stack.at(-1)
      if (top.keys) top.expectKey = true
      else top.index++
    }
    i++
  }
  return null
}
