import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose private seams from an isolated copy, without adding production exports.
// These cases cover the assistant-prefill tail: run positions, validation, the
// continuation carrier rendering, the cross-turn ledger alignment, and the
// AGY_BRIDGE_PREFILL=0 stock-behavior toggle.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-prefill-tail-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { trailingMessages, prefillRun, assistantTextOf, validateBody, renderTurnMessagesParts, renderInitialPromptParts, dropTerminalToolResultPrefill, estimateInputTokens };\n")
const { trailingMessages, prefillRun, assistantTextOf, validateBody, renderTurnMessagesParts, renderInitialPromptParts, dropTerminalToolResultPrefill, estimateInputTokens } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const U = text => ({ role: "user", content: text })
const A = text => ({ role: "assistant", content: text })
const S = text => ({ role: "system", content: text })
const toolUseTail = () => ({ role: "assistant", content: [{ type: "text", text: "working" }, { type: "tool_use", id: "call_a", name: "Read", input: { path: "a" } }] })
const join = parts => parts.map(part => part?.text || "").join("")
const toolUse = (id, name, text) => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text", text }] : []),
    { type: "tool_use", id, name, input: { path: id } },
  ],
})
const toolResult = (id, content) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] })
const livePrefill = (tail, extra = []) => ({
  messages: [U("earlier ask"), A("earlier reply"), U("read the file"), toolUse("call_a", "Read", "Looking now"), toolResult("call_a", "file body"), ...extra, ...(Array.isArray(tail) ? tail : [tail])],
})

test("assistantTextOf collects text blocks and refuses anything else", () => {
  assert.equal(assistantTextOf(A("abc")), "abc")
  assert.equal(assistantTextOf({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab")
  assert.equal(assistantTextOf({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "x", name: "f", input: {} }] }), null)
  assert.equal(assistantTextOf(A("")), "")
})

test("prefillRun locates the trailing text-only assistant run", () => {
  assert.deepEqual(prefillRun([U("1"), A("p1"), A("r1"), U("2"), A("p2")]), { runStart: 4, boundary: 3 })
  assert.deepEqual(prefillRun([U("1"), A("p")]), { runStart: 1, boundary: 0 })
  assert.deepEqual(prefillRun([A("r"), A("p")]), { runStart: 0, boundary: 0 })
  assert.equal(prefillRun([U("1"), A("r1"), U("2")]), null, "a user tail is not a prefill")
  assert.equal(prefillRun([U("1"), toolUseTail()]), null, "a tool_use tail is not a prefill")
})

test("trailingMessages keeps a prefill tail out of the replayed history", () => {
  const { history, messages } = trailingMessages({ messages: [U("1"), A("p1"), A("r1"), U("2"), A("p2")] })
  assert.deepEqual(history, [U("1"), A("p1"), A("r1")])
  assert.deepEqual(messages, [U("2"), A("p2")])
  const fresh = trailingMessages({ messages: [U("1"), A("p")] })
  assert.deepEqual(fresh.history, [])
  assert.deepEqual(fresh.messages, [U("1"), A("p")])
  const withSystem = trailingMessages({ messages: [S("sys"), U("1"), A("p1"), A("r1"), U("2"), A("p2")] })
  assert.deepEqual(withSystem.history, [U("1"), A("p1"), A("r1")], "a leading system message is promoted, not replayed")
  const normal = trailingMessages({ messages: [U("1"), A("r1"), U("2")] })
  assert.deepEqual(normal.history, [U("1"), A("r1")])
  assert.deepEqual(normal.messages, [U("2")])
})

test("the session ledger stays aligned with the client history across prefill turns", () => {
  // turn 1: a fresh prefill request. startTurn records the client messages and
  // recordAssistantResponse appends the reply.
  const t1 = trailingMessages({ messages: [U("one"), A("<story>")] })
  assert.deepEqual(t1.history, [])
  const ledger = [...t1.messages, A("first reply")]
  // turn 2: the client re-sends its history plus the next prefill. The patched
  // boundary must land exactly on the ledger, or the session would be retired.
  const t2 = trailingMessages({ messages: [...ledger, U("two"), A("<story> two")] })
  assert.deepEqual(t2.history, ledger, "cross-turn ledger alignment")
  ledger.push(U("two"), A("<story> two"), A("second reply"))
  // turn 3: a plain user turn (no prefill) keeps aligning with the ledger.
  const t3 = trailingMessages({ messages: [...ledger, U("three")] })
  assert.deepEqual(t3.history, ledger)
})

test("validateBody serves a prefill tail and rejects the unsupported shapes", () => {
  validateBody({ messages: [U("1"), A("p")] })
  validateBody({ messages: [U("1"), A("p1"), A("r1"), U("2"), A("p2")] })
  assert.throws(() => validateBody({ messages: [A("r"), A("p")] }), /no user turn to continue from/)
  assert.throws(() => validateBody({ messages: [U("1"), toolUseTail()] }), /not from the user or a tool-result/)
  // Un-normalized, a live tool_result plus a text prefill is still rejected.
  // The request path drops that prefill before it calls validateBody.
  assert.throws(
    () => validateBody({ messages: [U("1"), A("r1"), { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "done" }] }, A("p")] }),
    /tool_result with an assistant prefill/,
  )
})

test("a terminal text prefill after a live tool_result is dropped and the tool turn validates", () => {
  const stringTail = livePrefill(A("DONE"))
  const blockTail = livePrefill({ role: "assistant", content: [{ type: "text", text: "PRE" }, { type: "text", text: "FILL" }] })
  for (const [label, body] of [["messages string", stringTail], ["messages blocks", blockTail], ["chat stream", { ...stringTail, stream: true }], ["chat nonstream", { ...blockTail, stream: false }]]) {
    const normalized = dropTerminalToolResultPrefill(body)
    assert.notEqual(normalized, body, label)
    assert.equal(normalized.stream, body.stream, label)
    assert.deepEqual(normalized.messages.at(-1), toolResult("call_a", "file body"), label)
    const flat = JSON.stringify(normalized.messages)
    assert.equal(flat.includes("DONE"), false, label)
    assert.equal(flat.includes("\"PRE\""), false, label)
    assert.equal(flat.includes("\"FILL\""), false, label)
    assert.equal(flat.includes("Looking now"), true, label)
    assert.equal(flat.includes("earlier reply"), true, label)
    validateBody(normalized)
    const rendered = join(renderTurnMessagesParts(trailingMessages(normalized).messages))
    assert.equal(rendered.includes("file body"), true, label)
    assert.equal(rendered.includes("DONE"), false, label)
    assert.equal(rendered.includes("PRE"), false, label)
    assert.equal(rendered.includes("FILL"), false, label)
    assert.equal(rendered.includes("unfinished reply"), false, label)
  }
  assert.deepEqual(dropTerminalToolResultPrefill(stringTail).messages, dropTerminalToolResultPrefill(dropTerminalToolResultPrefill(stringTail)).messages)
})

test("several tool results and a split text run are kept or dropped as a whole", () => {
  const parallel = {
    messages: [
      U("read both"),
      { role: "assistant", content: [{ type: "text", text: "Reading both" }, { type: "tool_use", id: "call_a", name: "Read", input: {} }, { type: "tool_use", id: "call_b", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "result one" }, { type: "tool_result", tool_use_id: "call_b", content: "result two" }] },
      A("part one"),
      A("part two"),
    ],
  }
  const normalized = dropTerminalToolResultPrefill(parallel)
  assert.equal(normalized.messages.length, 3)
  assert.deepEqual(normalized.messages.at(-1).content.map(block => block.content), ["result one", "result two"])
  assert.equal(JSON.stringify(normalized.messages).includes("Reading both"), true)
  assert.equal(JSON.stringify(normalized.messages).includes("part one"), false)
  validateBody(normalized)

  const sequential = {
    messages: [
      U("one then two"),
      toolUse("call_a", "Read", "first"),
      toolResult("call_a", "result one"),
      toolUse("call_b", "Read", "second"),
      toolResult("call_b", "result two"),
      A("DONE"),
    ],
  }
  const sequentialOut = dropTerminalToolResultPrefill(sequential)
  assert.deepEqual(sequentialOut.messages, sequential.messages.slice(0, -1))
  validateBody(sequentialOut)

  const steered = livePrefill(A("DONE"), [U("also note this")])
  const steeredOut = dropTerminalToolResultPrefill(steered)
  assert.equal(steeredOut.messages.at(-1).content, "also note this")
  assert.equal(JSON.stringify(steeredOut.messages).includes("file body"), true)
  validateBody(steeredOut)
})

test("normalization leaves history, bare prefills, and non-text tails alone", () => {
  const bare = { messages: [U("1"), A("p")] }
  assert.equal(dropTerminalToolResultPrefill(bare), bare)
  validateBody(bare)

  const closed = {
    messages: [U("1"), toolUse("call_a", "Read", "Looking"), toolResult("call_a", "file body"), A("final answer"), U("thanks"), A("next prefill")],
  }
  assert.equal(dropTerminalToolResultPrefill(closed), closed)
  validateBody(closed)
  assert.equal(JSON.stringify(closed.messages).includes("final answer"), true)

  const unanswered = { messages: [U("1"), toolUseTail()] }
  assert.equal(dropTerminalToolResultPrefill(unanswered), unanswered)
  assert.throws(() => validateBody(unanswered), /not from the user or a tool-result/)

  const thinkingTail = livePrefill({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "DONE" }] })
  assert.equal(dropTerminalToolResultPrefill(thinkingTail), thinkingTail)
  assert.throws(() => validateBody(thinkingTail), /not from the user or a tool-result/)

  const newCall = livePrefill({ role: "assistant", content: [{ type: "text", text: "DONE" }, { type: "tool_use", id: "call_b", name: "Read", input: {} }] })
  assert.equal(dropTerminalToolResultPrefill(newCall), newCall)
  assert.throws(() => validateBody(newCall), /not from the user or a tool-result/)

  const between = livePrefill([
    { role: "assistant", content: [{ type: "thinking", thinking: "between" }] },
    A("DONE"),
  ])
  assert.equal(dropTerminalToolResultPrefill(between), between)
  validateBody(between)

  const noResult = { messages: [U("1"), toolUse("call_a", "Read"), toolResult("call_a", "kept")] }
  assert.equal(dropTerminalToolResultPrefill(noResult), noResult)
  validateBody(noResult)
})

test("the dropped prefill is absent from the input token estimate", () => {
  const prefill = "PREFILL-TOKEN-MARKER " + "x".repeat(4000)
  const body = livePrefill(A(prefill))
  body.tools = [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }]
  const normalized = dropTerminalToolResultPrefill(body)
  const without = { ...body, messages: body.messages.slice(0, -1) }
  assert.equal(estimateInputTokens(normalized), estimateInputTokens(without))
  assert.ok(estimateInputTokens(body) > estimateInputTokens(normalized) + 500)
  assert.equal(JSON.stringify(normalized).includes("PREFILL-TOKEN-MARKER"), false)
  assert.equal(JSON.stringify(normalized).includes("file body"), true)
})

test("a trailing prefill run renders as a continuation carrier, not a system reminder", () => {
  process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE = "CARRIER-NOTE-MARKER"
  try {
    const text = join(renderTurnMessagesParts([U("stay aside"), A("<story>opening")]))
    assert.ok(text.includes("CARRIER-NOTE-MARKER"), "the carrier note is rendered")
    assert.ok(text.includes("<story>opening"), "the prefill fragment is rendered")
    assert.ok(!text.includes("system-reminder"), "the stock system-reminder wrap is replaced")
    const normal = join(renderTurnMessagesParts([U("1"), A("r1"), U("2")]))
    assert.ok(!normal.includes("CARRIER-NOTE-MARKER"), "a plain request renders without the carrier")
  } finally {
    delete process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE
  }
})

test("a fresh session's initial prompt carries the prefill carrier too", () => {
  process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE = "CARRIER-NOTE-MARKER"
  try {
    const text = join(renderInitialPromptParts({ messages: [U("one"), A("<story>opening")] }, null, true))
    assert.ok(text.includes("CARRIER-NOTE-MARKER"))
    assert.ok(text.includes("<story>opening"))
  } finally {
    delete process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE
  }
})

test("AGY_BRIDGE_PREFILL=0 restores the stock reject and the stock split", () => {
  process.env.AGY_BRIDGE_PREFILL = "0"
  try {
    assert.throws(() => validateBody({ messages: [U("1"), A("p")] }), /not from the user or a tool-result/)
    const combined = livePrefill(A("DONE"))
    assert.equal(dropTerminalToolResultPrefill(combined), combined)
    assert.throws(() => validateBody(combined), /not from the user or a tool-result/)
    const { history, messages } = trailingMessages({ messages: [U("1"), A("p")] })
    assert.deepEqual(messages, [])
    assert.deepEqual(history, [U("1"), A("p")])
    // prefillRun itself is pure geometry and stays toggle-agnostic: the
    // callers (trailingMessages, validateBody, the renderer) gate on
    // prefillTailEnabled, so only their behavior changes with the toggle.
  } finally {
    delete process.env.AGY_BRIDGE_PREFILL
  }
})

test("the boundary transform is deterministic for identical requests", () => {
  const body = { messages: [U("1"), A("p1"), A("r1"), U("2"), A("p2")] }
  assert.deepEqual(trailingMessages(body), trailingMessages(body))
})
