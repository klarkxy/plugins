// Standalone checks for RE2 pattern sanitization. Run with:
//   node test/re2-pattern-unit.mjs
import { strict as assert } from "node:assert"
import {
  translateUnicodeEscapes,
  isRE2Safe,
  sanitizePatternString,
  sanitizePatternFields,
} from "../re2-pattern.mjs"
import { sanitizeInputSchema } from "../index.mjs"

const NUL_CLASS = "^[^\\u0000]*$"
const NUL_CLASS_RE2 = "^[^\\x{0000}]*$"
const PATH_LOOKAHEAD = "^/(?!/)(?:[^\\u0000-\\u0020\\u007f\\\\#%]|%[0-9a-fA-F]{2})*(?![\\s\\S])"

let failed = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok  ${name}`)
    return
  }
  failed++
  console.error(`FAIL ${name}${detail ? " :: " + detail : ""}`)
}

check("translate \\u0000 in a character class",
  translateUnicodeEscapes(NUL_CLASS) === NUL_CLASS_RE2,
  translateUnicodeEscapes(NUL_CLASS))

check("translate \\u{0000} and \\u007f",
  translateUnicodeEscapes("\\u{0000}\\u007f") === "\\x{0000}\\x{007f}",
  translateUnicodeEscapes("\\u{0000}\\u007f"))

check("translate is idempotent on \\x{0000}",
  translateUnicodeEscapes(NUL_CLASS_RE2) === NUL_CLASS_RE2)

check("does not translate a literal backslash-u sequence",
  translateUnicodeEscapes("\\\\u0000") === "\\\\u0000")

check("translated NUL class is RE2-safe", isRE2Safe(NUL_CLASS_RE2))
check("untranslated \\u0000 is not RE2-safe", !isRE2Safe(NUL_CLASS))
check("lookahead path pattern is not RE2-safe even after translation",
  !isRE2Safe(translateUnicodeEscapes(PATH_LOOKAHEAD)))

check("plain ^[a-z]+$ is RE2-safe", isRE2Safe("^[a-z]+$"))
check("non-capturing group and digits are RE2-safe", isRE2Safe("(?:foo){1,3}"))
check("\\p{L} is RE2-safe", isRE2Safe("\\p{L}+"))
check("named group is RE2-safe", isRE2Safe("(?P<name>[a-z]+)"))
check("flags group is RE2-safe", isRE2Safe("(?i)abc"))
check("possessive *+ is not RE2-safe", !isRE2Safe("a*+"))
check("lookahead is not RE2-safe", !isRE2Safe("(?=a)"))
check("lookbehind is not RE2-safe", !isRE2Safe("(?<=a)"))
check("backreference is not RE2-safe", !isRE2Safe("(a)\\1"))
check("unclosed class is not RE2-safe", !isRE2Safe("[a-z"))
check("trailing backslash is not RE2-safe", !isRE2Safe("abc\\"))

{
  const kept = sanitizePatternString(NUL_CLASS)
  check("sanitizePatternString keeps translated NUL class",
    kept.ok && kept.pattern === NUL_CLASS_RE2, JSON.stringify(kept))
  const dropped = sanitizePatternString(PATH_LOOKAHEAD)
  check("sanitizePatternString drops lookahead path pattern",
    !dropped.ok && dropped.pattern === undefined, JSON.stringify(dropped))
}

{
  const node = { type: "string", description: "a path", pattern: PATH_LOOKAHEAD }
  sanitizePatternFields(node)
  check("sanitizePatternFields drops invalid pattern and hints with the original",
    node.pattern === undefined && typeof node.description === "string"
      && node.description.includes("pattern: ")
      && node.description.includes("(?!/)")
      && !node.description.includes("pattern: pattern:"),
    JSON.stringify(node))
}

{
  const node = { type: "string", pattern: NUL_CLASS }
  sanitizePatternFields(node)
  check("sanitizePatternFields rewrites a translatable pattern in place",
    node.pattern === NUL_CLASS_RE2 && node.description === undefined,
    JSON.stringify(node))
  sanitizePatternFields(node)
  check("sanitizePatternFields is idempotent after a rewrite",
    node.pattern === NUL_CLASS_RE2 && node.description === undefined,
    JSON.stringify(node))
}

{
  const node = {
    type: "object",
    patternProperties: {
      [NUL_CLASS]: { type: "string" },
      [PATH_LOOKAHEAD]: { type: "number" },
    },
  }
  sanitizePatternFields(node)
  check("patternProperties: translatable key is rewritten, invalid key is dropped",
    Object.keys(node.patternProperties).length === 1
      && Object.hasOwn(node.patternProperties, NUL_CLASS_RE2)
      && (node.description || "").includes("dropped patternProperties"),
    JSON.stringify(node))
}

{
  const schema = sanitizeInputSchema({
    type: "object",
    properties: {
      sourcePath: { type: "string", description: "source", pattern: NUL_CLASS },
      path: { type: "string", description: "unix path", pattern: PATH_LOOKAHEAD },
      nested: {
        type: "object",
        properties: {
          inner: { type: "string", pattern: NUL_CLASS },
        },
      },
      list: {
        type: "array",
        items: { type: "string", pattern: PATH_LOOKAHEAD },
      },
      either: {
        anyOf: [
          { type: "string", pattern: NUL_CLASS },
          { type: "string", pattern: PATH_LOOKAHEAD },
        ],
      },
    },
    required: ["sourcePath"],
  })
  const source = schema.properties.sourcePath
  const path = schema.properties.path
  const inner = schema.properties.nested.properties.inner
  const item = schema.properties.list.items
  const [okBranch, badBranch] = schema.properties.either.anyOf
  check("sanitizeInputSchema rewrites nested sourcePath",
    source.pattern === NUL_CLASS_RE2, JSON.stringify(source))
  check("sanitizeInputSchema drops nested lookahead path and hints",
    path.pattern === undefined && /pattern: /.test(path.description || ""),
    JSON.stringify(path))
  check("sanitizeInputSchema rewrites items / anyOf / nested objects",
    inner.pattern === NUL_CLASS_RE2
      && item.pattern === undefined
      && okBranch.pattern === NUL_CLASS_RE2
      && badBranch.pattern === undefined,
    JSON.stringify({ inner, item, okBranch, badBranch }))
  const again = sanitizeInputSchema(schema)
  check("sanitizeInputSchema is idempotent on an already-sanitized tree",
    JSON.stringify(again) === JSON.stringify(schema))
}

// Existing sanitizer behaviour should still hold (enum / union / dangling required).
{
  const schema = sanitizeInputSchema({
    type: "object",
    properties: {
      union_arr: { type: ["object", "array"], items: { type: "string" } },
      stale_items: { type: ["string", "number"], items: { type: "string" }, properties: { bad: { type: "string" } } },
      num_enum: { type: "integer", enum: [0, 1, 2] },
    },
    required: ["union_arr", "missing_field"],
  })
  check("existing union / stale / enum / required sanitizer still applies",
    schema.properties.union_arr.type === "array"
      && schema.properties.stale_items.items === undefined
      && schema.properties.stale_items.properties === undefined
      && schema.properties.num_enum.enum === undefined
      && /Allowed values: 0, 1, 2/.test(schema.properties.num_enum.description || "")
      && JSON.stringify(schema.required) === JSON.stringify(["union_arr"]),
    JSON.stringify(schema))
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nALL OK")
