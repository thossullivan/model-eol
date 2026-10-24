const NAMED_CONTROLS = new Map([['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t']])

// controls, bidi overrides, zero-width marks, and line separators all print as escapes
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

// the Actions runner reads ##[ as a legacy workflow command anywhere in a line
export const printable = value => String(value).replace(HIDDEN, character => {
  const code = character.charCodeAt(0)
  return NAMED_CONTROLS.get(character) ?? (code < 0x80 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`)
}).replaceAll('##[', '#\\x23[')

// keeps intentional line breaks, but no line may start a :: workflow command
export const printableLines = value => String(value).split('\n').map(line => printable(line).replace(/^(\s*):(?=:)/, '$1\\x3a')).join('\n')
