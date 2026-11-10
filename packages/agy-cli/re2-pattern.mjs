// RE2-safe JSON Schema `pattern` / `patternProperties` handling for agy.
//
// agy validates every tool parameter schema against the JSON Schema 2020-12
// metaschema using Go's `regexp` library (RE2). JSON Schema defines `pattern`
// as an ECMA-262 regular expression, so constructs that are legal in JavaScript
// — `\uXXXX` / `\u{...}` escapes, lookaheads, backreferences — make agy fail
// "building toolbox" and abort the whole turn before any model call.
//
// We translate the Unicode escapes RE2 can express (`\uXXXX` → `\x{XXXX}`),
// then drop anything still not compilable as RE2 into a description hint.
// The rewrite is idempotent. Tool-call arguments are plain JSON values, not
// patterns, so the response path needs no reverse transform.
//
// See: https://github.com/google-antigravity/antigravity-cli/issues/1327

const HINT_PREFIX = "pattern: "

export function appendHint(node, hint) {
  if (!hint || !node || typeof node !== "object" || Array.isArray(node)) return
  if (typeof node.description === "string" && node.description.trim()) {
    if (!node.description.includes(hint)) node.description = `${node.description} (${hint})`
  } else {
    node.description = hint
  }
}

// Escape-aware translation of ECMA-262 Unicode escapes into RE2 `\x{...}`.
// `\\u0000` (a literal backslash then the letters u0000) is left alone.
export function translateUnicodeEscapes(source) {
  if (typeof source !== "string") return source
  let out = ""
  let i = 0
  while (i < source.length) {
    if (source[i] !== "\\") {
      out += source[i++]
      continue
    }
    const rest = source.slice(i + 1)
    let match = /^u\{([0-9a-fA-F]+)\}/.exec(rest)
    if (match) {
      out += `\\x{${match[1]}}`
      i += 1 + match[0].length
      continue
    }
    match = /^u([0-9a-fA-F]{4})/.exec(rest)
    if (match) {
      out += `\\x{${match[1]}}`
      i += 1 + match[0].length
      continue
    }
    // Occasional non-ECMA 8-digit form; RE2 accepts the same code point as `\x{...}`.
    match = /^U([0-9a-fA-F]{8})/.exec(rest)
    if (match) {
      out += `\\x{${match[1]}}`
      i += 1 + match[0].length
      continue
    }
    out += source[i++]
    if (i < source.length) out += source[i++]
  }
  return out
}

// Letters Go's regexp / RE2 accept after a backslash. Unknown letter escapes
// (`\u` after translation, `\1`, `\C`, `\Z`, `\k`, …) are rejected so a
// leftover construct cannot fail agy's metaschema check.
const RE2_LETTER_ESCAPES = new Set([
  "a", "f", "n", "r", "t", "v",
  "A", "b", "B", "d", "D", "s", "S", "w", "W", "z",
  "Q", "E", "x", "p", "P",
])

const RE2_GROUP_FLAGS = new Set(["i", "m", "s", "U"])

function isHex(char) {
  return /[0-9a-fA-F]/.test(char)
}

// Conservative RE2 compiler check. Returns true only when the pattern should
// compile with Go's `regexp.Compile` (the same engine agy uses). Anything we
// cannot positively accept is rejected, which drops the pattern into a hint
// rather than risking a toolbox failure.
export function isRE2Safe(source) {
  if (typeof source !== "string") return false
  const length = source.length
  let i = 0
  let depth = 0
  let inClass = false
  let classJustOpened = false
  let canQuantify = false

  const consumeEscape = (inCharClass) => {
    if (i >= length) return false
    const mark = source[i++]
    if (mark !== "\\") return false
    if (i >= length) return false
    const next = source[i++]
    if (next >= "1" && next <= "9") return false
    if (next === "0") {
      // \0, \00, or \000 — an octal byte, not a backreference.
      let extra = 0
      while (extra < 2 && i < length && source[i] >= "0" && source[i] <= "7") {
        i++
        extra++
      }
      return true
    }
    if (next === "x") {
      if (i < length && source[i] === "{") {
        i++
        let digits = 0
        while (i < length && isHex(source[i])) {
          i++
          digits++
        }
        if (digits === 0 || i >= length || source[i] !== "}") return false
        i++
        return true
      }
      if (i + 1 < length && isHex(source[i]) && isHex(source[i + 1])) {
        i += 2
        return true
      }
      return false
    }
    if (next === "p" || next === "P") {
      if (i < length && source[i] === "{") {
        i++
        let name = 0
        while (i < length && source[i] !== "}") {
          const char = source[i]
          if (!/[A-Za-z0-9_&=+-]/.test(char)) return false
          i++
          name++
        }
        if (name === 0 || i >= length || source[i] !== "}") return false
        i++
        return true
      }
      if (i < length && /[A-Za-z]/.test(source[i])) {
        i++
        return true
      }
      return false
    }
    if (next === "Q") {
      if (inCharClass) return true
      while (i < length) {
        if (source[i] === "\\" && i + 1 < length && source[i + 1] === "E") {
          i += 2
          return true
        }
        i++
      }
      return true
    }
    if (next === "u" || next === "U" || next === "C" || next === "k" || next === "Z" || next === "G") {
      return false
    }
    if (/[A-Za-z]/.test(next)) return RE2_LETTER_ESCAPES.has(next)
    return true
  }

  const consumeRepeat = () => {
    // Called at `{` when a quantifier is allowed. If this is not a well-formed
    // bound, treat `{` as a literal (RE2's behaviour).
    const start = i
    i++
    if (i >= length || source[i] < "0" || source[i] > "9") {
      i = start + 1
      canQuantify = true
      return true
    }
    while (i < length && source[i] >= "0" && source[i] <= "9") i++
    if (i < length && source[i] === ",") {
      i++
      while (i < length && source[i] >= "0" && source[i] <= "9") i++
    }
    if (i >= length || source[i] !== "}") {
      i = start + 1
      canQuantify = true
      return true
    }
    i++
    if (i < length && source[i] === "?") i++
    else if (i < length && source[i] === "+") return false
    canQuantify = false
    return true
  }

  const consumeGroup = () => {
    // Called at `(`.
    i++
    if (i < length && source[i] === "?") {
      i++
      if (i >= length) return false
      const next = source[i]
      if (next === ":") {
        i++
        depth++
        canQuantify = false
        return true
      }
      if (next === "P") {
        i++
        if (i >= length || source[i] !== "<") return false
        i++
        let name = 0
        while (i < length && source[i] !== ">") {
          if (!/[A-Za-z0-9_]/.test(source[i])) return false
          i++
          name++
        }
        if (name === 0 || i >= length || source[i] !== ">") return false
        i++
        depth++
        canQuantify = false
        return true
      }
      // Flags: (?imsU) or (?imsU-imsU) or (?imsU:...) — not lookaheads.
      let flags = 0
      while (i < length && RE2_GROUP_FLAGS.has(source[i])) {
        i++
        flags++
      }
      if (i < length && source[i] === "-") {
        i++
        while (i < length && RE2_GROUP_FLAGS.has(source[i])) {
          i++
          flags++
        }
      }
      if (i < length && source[i] === ":") {
        if (flags === 0) return false
        i++
        depth++
        canQuantify = false
        return true
      }
      if (i < length && source[i] === ")") {
        if (flags === 0) return false
        i++
        canQuantify = false
        return true
      }
      // `(?=`, `(?!`, `(?<=`, `(?<!`, `(?>`, `(?(`, `(?<name>` …
      return false
    }
    depth++
    canQuantify = false
    return true
  }

  while (i < length) {
    const char = source[i]
    if (inClass) {
      if (char === "\\") {
        if (!consumeEscape(true)) return false
        classJustOpened = false
        continue
      }
      if (char === "]" && !classJustOpened) {
        inClass = false
        canQuantify = true
        i++
        continue
      }
      classJustOpened = false
      i++
      continue
    }

    if (char === "\\") {
      if (!consumeEscape(false)) return false
      canQuantify = true
      continue
    }
    if (char === "[") {
      inClass = true
      classJustOpened = true
      i++
      if (i < length && source[i] === "^") i++
      canQuantify = false
      continue
    }
    if (char === "]") return false
    if (char === "(") {
      if (!consumeGroup()) return false
      continue
    }
    if (char === ")") {
      if (depth <= 0) return false
      depth--
      canQuantify = true
      i++
      continue
    }
    if (char === "*" || char === "+" || char === "?") {
      if (!canQuantify) return false
      i++
      if (i < length && source[i] === "?") i++
      else if (i < length && source[i] === "+") return false
      canQuantify = false
      continue
    }
    if (char === "{") {
      if (!canQuantify) {
        i++
        canQuantify = true
        continue
      }
      if (!consumeRepeat()) return false
      continue
    }
    if (char === "|" || char === "^" || char === "$") {
      canQuantify = false
      i++
      continue
    }
    canQuantify = true
    i++
  }
  return !inClass && depth === 0
}

export function sanitizePatternString(original) {
  if (typeof original !== "string") {
    return { ok: false, pattern: undefined, original }
  }
  const translated = translateUnicodeEscapes(original)
  if (isRE2Safe(translated)) {
    return { ok: true, pattern: translated, original }
  }
  return { ok: false, pattern: undefined, original }
}

// Mutates a single schema node: `pattern` and `patternProperties` keys.
// Recursion into child schemas is the caller's job (sanitizeInputSchema).
export function sanitizePatternFields(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node

  if (Object.hasOwn(node, "pattern")) {
    const result = sanitizePatternString(node.pattern)
    if (result.ok) {
      node.pattern = result.pattern
    } else {
      const shown = typeof result.original === "string" ? result.original : JSON.stringify(result.original)
      appendHint(node, `${HINT_PREFIX}${shown}`)
      delete node.pattern
    }
  }

  if (node.patternProperties && typeof node.patternProperties === "object" && !Array.isArray(node.patternProperties)) {
    const next = {}
    const dropped = []
    for (const [key, value] of Object.entries(node.patternProperties)) {
      const result = sanitizePatternString(key)
      if (result.ok) next[result.pattern] = value
      else dropped.push(key)
    }
    if (dropped.length) {
      appendHint(node, `dropped patternProperties: ${dropped.join(", ")}`)
    }
    if (Object.keys(next).length) node.patternProperties = next
    else delete node.patternProperties
  }

  return node
}
