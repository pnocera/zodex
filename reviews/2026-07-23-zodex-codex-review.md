# zodex review — 2026-07-23

General correctness/robustness review of the zodex codebase (current working tree,
commit `6b97ef0`). Verified against source, not the prose description. `bun run
typecheck` and `bun test` (40/0) reproduced green locally.

Findings are grouped BLOCKER / WARN / NIT, each with `file:line` and a concrete fix.
A separate "Test-suite false-green audit" section follows the source findings, since
the request weights it equally.

---

## BLOCKER

### B1 — CRLF-framed upstream SSE is never split into events
`src/responses.ts:675`

`parseChatCompletionSse` splits the upstream stream on `buffer.indexOf("\n\n")`. The
SSE spec allows events to be framed with either `\n\n` or `\r\n\r\n` as the event
delimiter. With CRLF framing the buffer contains `...\r\n\r\n...`, and `indexOf("\n\n")`
returns `-1` (the two `\n` bytes are separated by `\r`), so every event accumulates in
`buffer` until EOF and is never yielded. A CRLF-speaking upstream (some proxies and
non-Z.AI OpenAI-compatible servers, and any server that re-encodes through a CRLF
normalizing layer) would produce a single empty `response.completed` with no deltas and
no error.

Verified empirically: `"data: {}\r\n\r\ndata: [DONE]\r\n\r\n".indexOf("\n\n")` is `-1`,
while `.indexOf("\r\n\r\n")` is `13`.

Fix: detect both delimiters. Replace the boundary scan with one that tolerates CRLF:

```ts
// after: buffer += decoder.decode(value, { stream: true });
let boundary = buffer.search(/\r?\n\r?\n/);
while (boundary !== -1) {
  const sep = buffer[boundary] === "\r" ? 2 : 0; // width of leading \r
  const sepLen = /\r?\n\r?\n/.exec(buffer.slice(boundary))?.[0].length ?? 2;
  const rawEvent = buffer.slice(0, boundary);
  buffer = buffer.slice(boundary + sepLen);
  // ... existing per-line parsing (split(/\r?\n/) already handles line CRLFs)
  boundary = buffer.search(/\r?\n\r?\n/);
}
```

Or, simpler and sufficient, normalize the buffer on each append:
`buffer = buffer.replace(/\r\n/g, "\n")` before scanning, and keep the existing
`indexOf("\n\n")`. Either approach also fixes the latent issue that a trailing
`\r\n\r\n` (no final data line) currently leaves the last `[DONE]` unprocessed.

---

## WARN

### W1 — `fail()` emits `response.failed` without closing in-progress output items
`src/responses.ts:446`

When a stream errors mid-flight (upstream error, idle timeout, `content_filter`), the
server calls `translator.fail(status, message)` (server.ts:351). `fail()` emits only
`response.failed` + `[DONE]`. Any `response.output_item.added` that was already sent
for in-progress text/reasoning/tool-call items has no matching
`response.output_item.done`, and any open `response.content_part.added` /
`response.reasoning_summary_part.added` has no matching `.done`. Codex clients that
balance added/done events (and the OpenAI Responses event contract) expect the
in-progress items to be closed, typically with `status: "in_progress"` or a failed
item status, before the terminal event.

The non-stream error path (`errorResponse`) is fine because no items were ever opened.
This only affects the streaming failure path.

Fix: before emitting `response.failed`, close any open items. Add a `closeOpenItems()`
helper used by both `finish()` and `fail()` that, for each started-but-not-done item,
emits the appropriate `.done` event with the accumulated partial state and an
`in_progress`/`failed` status. At minimum, close `textStarted`, `reasoningStarted` not
`reasoningDone`, and every not-`done` tool in `toolsById`. Reuse the same emit shapes
as `finish()` but skip the final `response.completed`.

### W2 — Non-streaming upstream body is parsed without error handling
`src/server.ts:386`

```ts
const upstreamJson = (await upstream.json()) as ChatCompletionResponse;
```

If `upstream.ok` is true but the body is not valid JSON (truncated, HTML error page
served with 200, decompression hiccup, partial chunk), this throws an uncaught
exception inside `handleResponses`. Because `handleResponses` is the fetch handler,
Bun will return a 500 with no Responses-shaped body, and Codex sees a malformed error
rather than a `response.failed`. The streaming path handles this via the `try/catch`
around the SSE loop (server.ts:332); the non-stream path has no equivalent.

Fix: wrap the parse in `try/catch` and return a Responses error envelope on failure:

```ts
let upstreamJson: ChatCompletionResponse;
try {
  upstreamJson = (await upstream.json()) as ChatCompletionResponse;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  debug.log("response.non_stream.parse_failed", { request_id: id, error: message });
  return json(errorResponse(body, 502, `upstream returned invalid JSON: ${message}`), { status: 502 });
}
```

### W3 — Streaming error/timeout after partial output still returns HTTP 200 with a `response.failed` body
`src/server.ts:209`, `233`, `351`

All three streaming failure paths (fetch failure, non-2xx upstream, mid-stream error)
return `{ status: 200, headers: streamHeaders() }` and emit `response.failed` inside
the SSE body. This is deliberate and matches how the OpenAI Responses streaming
contract surfaces errors (terminal SSE event, not HTTP status), so it is not a bug
per se. The concern is the mid-stream case at server.ts:351: by the time the error
arrives, `response.created`, `response.in_progress`, and one or more
`output_item.added`/`...delta` events have already been sent with status 200. Codex
will correctly read `response.failed`, but combined with W1 the in-progress items are
left dangling. Fixing W1 resolves the structural issue here; no separate change needed
once W1 is addressed.

### W4 — Concurrent `install` runs race on `~/.zshrc` (read-modify-write, non-atomic)
`src/install.ts:338-344`

`install()` does `readText(zshrc) -> upsertMarkedBlock -> writeAtomic(zshrc)`. Each
individual `writeAtomic` is atomic (tmp + rename, install.ts:75), but the
read-modify-write of `~/.zshrc` across the whole function is not. Two concurrent
`zodex install` invocations (or `install` racing a user editing `.zshrc`) can both
read the same base content, both compute an updated copy, and the second rename
clobbers the first, silently losing any changes the first run (or the user) made
outside the managed block.

The same applies to `uninstall` (install.ts:357-358), which has no backup at all.

Fix: take an exclusive lock on the file before the read-modify-write, e.g. via
`flock`-style advisory locking using `openSync` + `fsync` + `O_EXCL` lockfile, or use
Bun's `Bun.file` with a `.${pid}.lock` sentinel and retry. At minimum, document the
non-concurrency assumption in the install command output. The catalog and profile
writes are safe because they are full-file overwrites, not merges.

### W5 — `~/.zshrc` backup is created once and never refreshed
`src/install.ts:339`

```ts
if (currentZshrc && !(await exists(backupPath))) {
  await copyFile(zshrcPath, backupPath);
}
```

The backup is only created if it does not already exist. On a second `install`, if
the user has since added unrelated content to `.zshrc`, the stale backup (from before
those changes) is kept and the new content is never backed up. If a later `install`
corrupts the file, restoring from `.zshrc.zodex.bak` loses the intervening user
edits.

Fix: refresh the backup on every install when the managed block is about to change
the content, or keep a timestamped backup (`~/.zshrc.zodex.bak.${Date.now()}`) so the
most recent pre-zodex state is always recoverable. If keeping the single-file
behavior, at least skip the backup only when the computed `updatedZshrc` equals the
current content (idempotent no-op).

### W6 — `repairJsonArguments` can silently corrupt valid JSON with trailing commas
`src/responses.ts:215`

The repair routine first strips trailing commas before `}` / `]`
(`replace(/,\s*([}\]])/g, "$1")`). This runs only when `JSON.parse` fails, so valid
JSON is untouched. However, for malformed arguments that happen to contain a trailing
comma inside a string value (e.g. `{"x":"a,b}"}` is valid, but a malformed
`{"x":"a,","y":1` would be "repaired" by deleting the comma inside the string literal,
yielding `{"x":"a""y":1` which still fails, so the original is returned — that path
is safe). The real risk is that the brace/bracket balancing appends `]`/`}` without
considering string boundaries: an unterminated string like `{"x":"abc{` would get `}`
appended to `{"x":"abc{}` which still fails parse and returns original — safe. After
tracing the paths, the repair is conservative (returns original on any failure), so
this is a WARN, not a BLOCKER: the concern is that partial tool-call argument streams
that are genuinely broken (not just truncated) get "repaired" into a different broken
shape that then fails at the model layer with a less obvious error than the original
truncation. Consider logging when repair changes the arguments so a malformed-stream
issue is diagnosable.

Fix: in `finish()`, when `repairJsonArguments` returns a different string than
`tool.arguments`, emit a debug trace event (e.g. `tool.arguments.repaired`) with the
original and repaired lengths so malformed upstream streams are visible in debug
logs.

---

## NIT

### N1 — Missing tool-call `id` in non-streaming output is passed through verbatim
`src/responses.ts:146`

`chatCompletionToResponse` forwards `call.id` directly to `functionCallItem`. If an
upstream returns a tool call with no `id` (some compatible servers do for single
calls), the resulting `function_call` item has `id: undefined` / `call_id: undefined`,
and Codex cannot correlate the subsequent `function_call_output`. The streaming path
synthesizes `call_${index}` (responses.ts:542); the non-stream path does not.

Fix: `const id = call.id || toolCallId();` before passing to `functionCallItem`, and
set both `id` and `call_id` to the same synthesized value (as the streaming path does
at responses.ts:580-581).

### N2 — `model` is unconditionally lowercased before forwarding
`src/translate.ts:335`

`String(request.model || defaultModel).toLowerCase()` matches the design intent
("Lowercase model names before forwarding upstream"), but some OpenAI-compatible
upstreams are case-sensitive on the model id. If a user sets `ZODEX_MODEL=GLM-5.2`
and the upstream expects exactly that casing, zodex silently sends `glm-5.2` and may
get a 404. The default (`glm-5.2`) is already lowercase so this is latent.

Fix: only lowercase when the value is not already a known-good form, or document that
`ZODEX_MODEL` must be supplied in the casing the upstream expects and forward
`request.model` as-is. At minimum, log the lowercased model in debug so a 404 is
diagnosable.

### N3 — `content-length` request header logged may be absent/incorrect for chunked bodies
`src/server.ts:164`

`request.headers.get("content-length")` is logged in `request.received`. For
chunked-transfer requests (no Content-Length header) this logs `null`, and for
requests where the client sends a misleading Content-Length it logs the claimed
value, not the actual `rawBody` size. The `body_bytes` field already logs the true
size, so this is informational only.

Fix: drop the `content-length` log field, or keep it but label it
`content_length_header` to distinguish from `body_bytes`.

### N4 — `ensureToolOutputsHaveCalls` scans the entire prior message list per tool message
`src/translate.ts:307`

For each `tool` message, it does `[...result].reverse().find(...)` to locate the
previous assistant message. This is O(n²) in the number of messages. For a long Codex
session with many tool round-trips this is wasteful, though not incorrect.

Fix: track the last assistant message index as you build `result`, and check
`tool_calls` on that one entry directly. Or, since the previous assistant is the most
recent assistant in `result`, iterate backward from the end without allocating a copy.

### N5 — `appendMessage` coalescing only merges assistant tool-call messages with null content
`src/translate.ts:69`

Two consecutive `function_call` items become two assistant messages with
`tool_calls` and `content: null`, which are coalesced into one message with both
tool_calls. Good. But if an assistant text message (`content: "text"`) is followed by
a `function_call` item, they are not coalesced (because `last.content` is truthy),
producing two separate assistant messages. Chat Completions expects a single assistant
turn to carry both content and tool_calls. Most upstreams tolerate adjacent assistant
messages, but some reject or merge unexpectedly.

Fix: when `message.role === "assistant"` and has `tool_calls` and `last` is an
assistant with string content and no tool_calls, merge `tool_calls` onto `last` and
keep `last.content`. This mirrors how the streaming path would reconstruct a single
turn.

### N6 — `firstToolName` fallback for synthetic tool outputs may name a tool the model did not call
`src/translate.ts:288`, `319`

When a `function_call_output` has no preceding `function_call` in the history,
`ensureToolOutputsHaveCalls` synthesizes an assistant tool_call using
`firstToolName(tools)` (the first function tool in the request). If the actual missing
call was to a different tool, the synthesized call has the wrong function name. This
is a best-effort repair for malformed Codex history (a tool output without a
matching call), so any name is a guess, but using the first tool is arbitrary.

Fix: acceptable as-is for a repair path, but log a debug warning when synthesizing so
malformed history is visible. Optionally use a neutral name like `"tool"` instead of
the first real tool to avoid implying a specific tool was called.

### N7 — `response.completed` `output` uses `filter(Boolean)` but items are never sparse
`src/responses.ts:437`

`this.output.filter(Boolean)` guards against holes in the `output` array. The array
is assigned by index (`this.output[tool.outputIndex] = item`), and indices are
allocated monotonically via `nextOutputIndex++`, so there are no holes unless an item
is never assigned (which only happens on the failure path, which returns early). The
`filter(Boolean)` is defensive but also drops any item that is falsy — not a real
concern here, but if a future item type is `0`/`""` it would be silently dropped.

Fix: use `this.output` directly, or replace `filter(Boolean)` with a comment
explaining the defensive intent. No behavior change needed.

### N8 — Debug `summarizeChatRequest` recomputes `JSON.stringify(translated)` for byte length
`src/server.ts:125`

`encodedLength(JSON.stringify(translated))` serializes the entire translated request
twice (once for the log field, once for the actual upstream body in
`fetchChatCompletions`). For large requests this is measurable but only runs when
debug is enabled, so it is acceptable.

Fix: none required; noted for awareness.

---

## Test-suite false-green audit

The request specifically asks for assertions that would still pass if behaviour
regressed. These are the holes I found.

### T1 — `decodeEvents` helper filters to `data: {` and silently drops `[DONE]` and non-JSON events
`tests/responses.test.ts:9-17`

```ts
return text.split("\n\n").filter((event) => event.startsWith("data: {"))
  .map((event) => JSON.parse(event.slice("data: ".length)));
```

This filters out the `data: [DONE]\n\n` terminator and any event whose payload does
not start with `{`. If the translator stopped emitting `response.completed` (the most
important terminal event), the tests that only check
`events.find((e) => e.type === "response.completed")` would fail — that is fine. But
tests that assert `events.map((e) => e.type).toContain(...)` would still pass even if
the `[DONE]` marker were missing, dropped, or malformed, because the helper strips
it. A regression that broke `[DONE]` emission (responses.ts:442) would not be caught.

Fix: add a test that asserts the raw SSE stream ends with `data: [DONE]\n\n` and that
`response.completed` is the last JSON event. Parse the raw text, not the filtered
list, for terminal-event ordering.

### T2 — No test covers the streaming `fail()` path, `content_filter`, or mid-stream error
`tests/responses.test.ts`

There is no test calling `translator.fail(...)` directly, no test feeding a chunk with
`finish_reason: "content_filter"`, and no test for the mid-stream error path in
`server.ts`. The `fail()` method (responses.ts:446) and the `content_filter` branch
(responses.ts:318) are completely untested. A regression that broke error event
shaping, dropped `[DONE]` on failure, or changed `errorCodeForStatus` mapping would
pass.

Fix: add tests:
- `translator.fail(502, "boom")` emits `response.failed` with the error envelope and
  a trailing `[DONE]`.
- `applyChunk({ choices: [{ finish_reason: "content_filter" }] })` followed by
  `finish()` emits `response.failed`, not `response.completed`.
- A chunk with `finish_reason: "length"` or `"stop"` does not set `this.failure`.

### T3 — Reasoning completion events (`reasoning_summary_text.done`, `output_item.done`) are not asserted
`tests/responses.test.ts:251-275`

The reasoning test only asserts `response.reasoning_summary_text.delta` is present
and the final `output[0]` shape. It does not assert that
`response.reasoning_summary_text.done` or `response.output_item.done` are emitted in
`finish()`. A regression that dropped the reasoning done events (responses.ts:349-364)
but still produced the correct final `output` array would pass.

Fix: assert the event type sequence includes
`response.reasoning_summary_part.added` → `response.reasoning_summary_text.delta` →
`response.reasoning_summary_text.done` → `response.output_item.done` for a reasoning
stream.

### T4 — No test covers `response.output_item.done` for text or tool-call items
`tests/responses.test.ts`

The text test (line 20) and tool-call test (line 60) only check the final
`response.completed.output`. The intermediate `response.output_item.done` events
emitted in `finish()` (responses.ts:394, 422) are not asserted. A regression that
dropped those events but still assembled the correct `output` array would pass.

Fix: assert `events` contains `response.output_item.done` with the matching
`output_index` and `item.id` for text and tool items.

### T5 — `parseChatCompletionSse` idle-timeout test uses `toContain` substring
`tests/responses.test.ts:439`

```ts
expect(message).toContain("upstream SSE idle timeout after 5ms for req_test");
```

A regression that changed the message format but kept the substring (e.g. dropped the
`for req_test` suffix but kept the prefix) would pass. More importantly, the test does
not assert that the reader was cancelled or that the iterator is truly done after the
throw — it only checks the error message.

Fix: assert the full message shape with `toBe` (or `toMatch` with anchored regex),
and assert the iterator's `done` state after the throw.

### T6 — `retryDelayMs` test does not cover `Retry-After` HTTP-date format
`tests/install.test.ts:152`

`retryDelayMs("2", 1)` tests the integer-seconds path. The HTTP spec also allows a
date format (`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`). The current code does
`Number(retryAfterHeader)`, which yields `NaN` for a date string and falls back to
exponential backoff. That is arguably correct behavior, but there is no test pinning
it, so a change that attempted to parse dates (and introduced a bug) would not be
caught.

Fix: add `expect(retryDelayMs("Wed, 21 Oct 2025 07:28:00 GMT", 0)).toBe(500)` to pin
the "non-numeric falls back to backoff" behavior.

### T7 — `upsertMarkedBlock` test does not verify the surrounding content is preserved on update
`tests/install.test.ts:119`

The double-upsert test checks the managed block content and that the old block is
gone, but does not assert that the `export PATH=/bin` line outside the block is still
present after the second upsert. A regression that truncated content before the block
on update would pass.

Fix: `expect(second).toContain("export PATH=/bin")` and assert the block is at the
end (or original position) with the surrounding lines intact.

### T8 — `chatCompletionToResponse` does not test a tool call with missing `id`
`tests/responses.test.ts:318`

The non-stream namespace test always supplies `id: "call_1"`. The streaming path
synthesizes ids (N1); the non-stream path does not. No test pins the behavior of a
missing id, so the N1 fix could regress later without detection.

Fix: add a test where `message.tool_calls[0]` has no `id` and assert the resulting
`function_call` item has a synthesized `id` (once N1 is fixed) or document the current
pass-through behavior.

### T9 — No test covers multiple/parallel tool calls in a single streaming response
`tests/responses.test.ts`

All streaming tool tests use a single tool call at `index: 0`. The
`toolIdByIndex`/`toolsById` machinery (responses.ts:537-620) and the synthetic-id
migration logic (responses.ts:543-559) are only exercised for one tool. A regression
in index-keyed state (e.g. two tools at indices 0 and 1 getting crossed) would not be
caught.

Fix: add a test with two tool calls in the same chunk (indices 0 and 1) and assert
both `function_call` items appear in `output` with the correct names and arguments.

### T10 — `decodeEvents` flattens chunks with `flatMap` then splits on `\n\n`, duplicating the parse logic under test
`tests/responses.test.ts:9-17`

The helper reimplements SSE framing (`split("\n\n")`) to parse the output of the
translator, which itself produces SSE. If the translator emitted events with a
different but still-valid framing (e.g. an extra blank line), the helper might miss
or merge events in a way that masks a bug. This is a minor risk given the translator
controls the output format, but the helper and the translator share the same framing
assumption, so a framing bug could be invisible to both.

Fix: low priority. Consider a parse helper that splits on `\n\n` and parses every
`data:` line regardless of payload shape, then filter by `type` in the test.

---

## Summary

The translation layer is well-structured and the streaming-event assembly is largely
correct. The main correctness gap is CRLF SSE framing (B1), which silently breaks
non-`\n\n`-framed upstreams. The streaming failure path leaves in-progress items
dangling (W1). The non-stream parse is unguarded (W2). Install mutations of
`~/.zshrc` are not concurrency-safe (W4) and the backup is stale-on-rerun (W5). The
test suite is green but has meaningful false-green holes: the failure/`content_filter`
paths are entirely untested (T2), reasoning/text completion events are not asserted
(T3, T4), the SSE helper strips `[DONE]` (T1), and parallel tool calls are not
exercised (T9).

VERDICT: FIXES_REQUIRED
