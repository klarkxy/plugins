import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose private seams from an isolated copy, without adding production exports.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-convkey-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(
  path.join(workspace, "bridge.mjs"),
  source + "\nexport { conversationKey, stripVolatileOpening, isContinuedOpening, openingTextOf, sameInstructions, historyKey };\n",
)
const {
  conversationKey,
  stripVolatileOpening,
  isContinuedOpening,
  openingTextOf,
  sameInstructions,
} = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

function body({ system, first, rest = [], userId } = {}) {
  const messages = []
  if (first != null) messages.push(typeof first === "string" ? { role: "user", content: first } : first)
  messages.push(...rest)
  const out = { model: "agy-cli/test-model", messages }
  if (system != null) out.system = system
  if (userId != null) out.metadata = { user_id: userId }
  return out
}

const STABLE = "Please review the following project files and propose a short fix.\n"

test("stripVolatileOpening removes billing headers, cch tokens, and date lines", () => {
  const raw = [
    "x-anthropic-billing-header: cc_version=2.0; cc_entrypoint=cli; cch=deadbeef01;",
    "Current date: 2026-11-10",
    "today: Tuesday, November 10, 2026 23:00",
    STABLE,
    "cch=abc123; still here",
    "Meet me at 12:00 in room 3.",
  ].join("\n")
  const stripped = stripVolatileOpening(raw)
  assert.equal(stripped.includes("x-anthropic-billing-header"), false)
  assert.equal(stripped.includes("cch="), false)
  assert.equal(stripped.includes("2026-11-10"), false)
  assert.equal(stripped.includes("November 10, 2026"), false)
  assert.equal(stripped.includes(STABLE.trim()), true)
  // A bare clock without a date is not stripped, so ordinary time mentions stay.
  assert.equal(stripped.includes("Meet me at 12:00 in room 3."), true)
})

test("conversationKey is stable when only the system clock or billing header changes", () => {
  const a = body({
    system: "You are a coding assistant.\nCurrent date: 2026-11-10\nx-anthropic-billing-header: cch=aaa111;",
    first: STABLE + "File A contents.",
    userId: "user-1",
  })
  const b = body({
    system: "You are a coding assistant.\nCurrent date: 2026-11-11\nx-anthropic-billing-header: cch=bbb222;",
    first: STABLE + "File A contents.",
    userId: "user-1",
  })
  assert.equal(conversationKey(a), conversationKey(b))
})

test("conversationKey is stable when the first message only differs by a date or cch token", () => {
  const a = body({
    first: `Current time: 2026-11-10T01:02:03Z\n${STABLE}cch=111aaa;`,
  })
  const b = body({
    first: `Current time: 2026-11-10T09:08:07Z\n${STABLE}cch=222bbb;`,
  })
  assert.equal(conversationKey(a), conversationKey(b))
})

test("conversationKey stays the same after later assistant and user turns are attached", () => {
  const first = STABLE + "Please start with src/app.ts."
  const turn1 = body({ system: "Be concise.", first })
  const turn2 = body({
    system: "Be concise.",
    first,
    rest: [
      { role: "assistant", content: "I will inspect src/app.ts." },
      { role: "user", content: "Also check the tests." },
    ],
  })
  assert.equal(conversationKey(turn1), conversationKey(turn2))
})

test("conversationKey uses a fixed opening prefix, so a long first message can grow and keep the key", () => {
  const opening = ("alpha prefix " + "X".repeat(9000)).slice(0, 9000)
  const turn1 = body({ first: opening })
  const turn2 = body({ first: opening + "\n--- later flattened turn ---\nbeta suffix" })
  assert.equal(conversationKey(turn1), conversationKey(turn2))
  assert.notEqual(
    conversationKey(body({ first: "Y".repeat(9000) })),
    conversationKey(turn1),
  )
})

test("conversationKey changes for a genuinely different first message or user id", () => {
  const base = body({ system: "S", first: STABLE, userId: "a" })
  assert.notEqual(conversationKey(base), conversationKey(body({ system: "S", first: STABLE + "other", userId: "a" })))
  assert.notEqual(conversationKey(base), conversationKey(body({ system: "S", first: STABLE, userId: "b" })))
  assert.notEqual(conversationKey(base), conversationKey(body({ system: "Other system", first: STABLE, userId: "a" })))
})

test("sameInstructions ignores volatile date and billing lines", () => {
  assert.equal(
    sameInstructions("Rules.\nCurrent date: 2026-11-10\n", "Rules.\nCurrent date: 2026-11-11\n"),
    true,
  )
  assert.equal(sameInstructions("Rules A", "Rules B"), false)
})


const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=" } }
const gif = { type: "image", source: { type: "base64", media_type: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" } }

test("conversationKey includes first-message images, so different pictures do not share a key", () => {
  const caption = { role: "user", content: [{ type: "text", text: "compare pictures " }, png, { type: "text", text: " and " }, gif] }
  const swapped = { role: "user", content: [{ type: "text", text: "compare pictures " }, gif, { type: "text", text: " and " }, png] }
  const same = { role: "user", content: [{ type: "text", text: "compare pictures " }, png, { type: "text", text: " and " }, gif] }
  assert.equal(conversationKey(body({ first: caption })), conversationKey(body({ first: same })))
  assert.notEqual(conversationKey(body({ first: caption })), conversationKey(body({ first: swapped })))
  const continued = body({
    first: caption,
    rest: [
      { role: "assistant", content: "They differ." },
      { role: "user", content: "recall the pictures" },
    ],
  })
  assert.equal(conversationKey(body({ first: caption })), conversationKey(continued))
})

test("isContinuedOpening detects a flattened first message that grows past the previous opening", () => {
  const first = { role: "user", content: STABLE + "step one" }
  const grown = { role: "user", content: STABLE + "step one\n\nassistant: done\n\nstep two is longer than four chars" }
  const proc = { openingText: openingTextOf(first) }
  assert.equal(isContinuedOpening(proc, first), false)
  assert.equal(isContinuedOpening(proc, grown), true)
  assert.equal(isContinuedOpening(proc, { role: "user", content: "totally different task" }), false)
  assert.equal(isContinuedOpening({ openingText: "" }, grown), false)
})
