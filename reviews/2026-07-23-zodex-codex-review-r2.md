# zodex re-review (round 2) — 2026-07-23

Independent re-verification of the working tree against the prior review
(`reviews/2026-07-23-zodex-codex-review.md`, verdict `FIXES_REQUIRED`). Every
prior finding — B1, W1–W6, N1–N8, T1–T10 — was re-checked against the current
source. `bun run typecheck` and `bun test` (52/0 across 5 files) reproduced
green locally. Additional empirical probes were run to verify event lifecycle
balance, CRLF framing across chunk boundaries, install idempotency, and
message coalescing.

Findings are grouped BLOCKER / WARN / NIT, each with `file:line` and a concrete
fix. Prior findings that are fully resolved are confirmed in the "Prior finding
resolution" section.

---

## BLOCKER

### B2 — `reasoning_summary_part.added` is never paired with `reasoning_summary_part.done`
`src/responses.ts:560` (emit added), `src/responses.ts:395-417` (closeOpenItems)

W1 asked that in-progress items be closed before the terminal event, with
matching `.done` for every `.added`. The fix correctly addressed the text and
tool paths: `content_part.added` is now paired with `content_part.done`
(responses.ts:438), and `output_item.added` is paired with `output_item.done`
for all item types. But the reasoning path was left half-fixed.

`reasoningDelta` emits `response.reasoning_summary_part.added` (responses.ts:560)
when reasoning starts. The `closeOpenItems` method emits
`response.reasoning_summary_text.done` and `response.output_item.done` for the
reasoning item (responses.ts:396-416), but never emits
`response.reasoning_summary_part.done`. Verified empirically in both the
success path and the failure path:

```
=== Reasoning lifecycle (success) ===
  response.created
  response.in_progress
  response.output_item.added
  response.reasoning_summary_part.added   <-- opened, never closed
  response.reasoning_summary_text.delta
  response.reasoning_summary_text.done
  response.output_item.done
  response.completed
```

```
=== Reasoning + fail ===
Has reasoning_summary_part.added: true
Has reasoning_summary_part.done: false
Part added: 1, Part done: 0
```

Contrast with the text path, which is balanced:

```
  response.output_item.added
  response.content_part.added
  response.output_text.delta
  response.output_text.done
  response.content_part.done               <-- correctly closed
  response.output_item.done
```

A Codex client that balances `*_part.added` / `*_part.done` events sees an
unclosed `reasoning_summary_part` for every reasoning response, in both the
success and failure paths. This is the exact class of dangling-item bug W1
targeted, and it is the more impactful half of W1 because reasoning content is
emitted on most GLM-5.2 responses with `reasoning_effort: max`.

Fix: in `closeOpenItems`, before emitting `reasoning_summary_text.done`, emit
`response.reasoning_summary_part.done` to close the part opened at line 560:

```ts
if (this.reasoningStarted && !this.reasoningDone) {
  events.push(
    this.emit("response.reasoning_summary_part.done", {
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: this.reasoning },
    }),
  );
  events.push(
    this.emit("response.reasoning_summary_text.done", {
      // ... existing fields
    }),
  );
  // ... existing output_item.done
```

This mirrors the `content_part.done` emit at responses.ts:438 and closes the
asymmetry.

---

## WARN

### W7 — `finish()` and `fail()` are not idempotent: a second call emits a duplicate terminal event with an empty/hole-filled `output`
`src/responses.ts:351-385`

`closeOpenItems` sets `textDone = true`, `reasoningDone = true`, and
`tool.done = true` as it closes each item, but `finish()` and `fail()` do not
guard against a second invocation. Calling `finish()` after `fail()` (or
`finish()` twice) emits a second terminal event (`response.completed` or
`response.failed`) with an empty `output` array (since `closeOpenItems` finds
nothing to close), plus a duplicate `data: [DONE]`. Verified empirically:

```
=== fail() then finish() ===
fail() types: [ "response.failed" ]
finish() types: [ "response.completed" ]   <-- duplicate terminal, empty output

=== finish() twice ===
1st finish() types: [ "response.completed" ]
2nd finish() types: [ "response.completed" ]   <-- duplicate terminal, empty output

=== content_filter finish() twice ===
1st finish() types: [ "response.failed" ]
2nd finish() types: [ "response.failed" ]   <-- duplicate terminal
```

In the current `server.ts` flow this is latent: `finish()` is called once at
server.ts:320, `fail()` is called once in each error branch (server.ts:213,
238, 351), and the branches are mutually exclusive (the `try` block calls
`finish()` and the `catch` block calls `fail()`). So no current code path
double-calls. However, the translator is a public class with no guard, and a
future caller (or a refactor that moves `finish()` outside the `try`) would
silently emit a second `response.completed` with empty output. This is the
same class of bug W1 fixed for the streaming failure path — the event stream
should have exactly one terminal event.

Fix: add a `finished` flag to the class and short-circuit `finish()` and
`fail()` on re-entry:

```ts
private finished = false;

finish(): Uint8Array[] {
  if (this.finished) return [];
  this.finished = true;
  // ... existing body
}

fail(status: number, message: string): Uint8Array[] {
  if (this.finished) return [];
  this.finished = true;
  // ... existing body
}
```

---

## NIT

### N9 — Stale lockfile causes a 5s delay with no cleanup path
`src/install.ts:97-132`

`withFileLock` retries `open(lockPath, "wx")` up to 50 times with 100ms sleeps.
If a prior `install`/`uninstall` crashed after creating the lock but before
unlinking it (process kill, OOM, filesystem error in the `finally`), the
lockfile persists and every subsequent run waits the full 5s before proceeding
without the lock. The `finally` block (install.ts:128-131) does close and
unlink, but a SIGKILL bypasses `finally`. There is no stale-lock detection
(e.g. checking the lockfile's mtime or writing the PID and checking
`process.kill(pid, 0)`).

This is a NIT because the fallback (proceed without lock) is safe for
single-user interactive installs — the worst case is a 5s delay, not
deadlock or data loss. But a crashed process leaving a lockfile would make
every future `zodex install` take 5s.

Fix: write the PID into the lockfile on creation, and on `EEXIST` check
whether the PID is still alive (`process.kill(pid, 0)`); if not, unlink the
stale lock and retry immediately. Alternatively, check the lockfile mtime and
treat locks older than a threshold (e.g. 30s) as stale.

### N10 — Timestamped backups accumulate without bound
`src/install.ts:405`, `src/install.ts:429`

Every `install` that changes `.zshrc` and every `uninstall` creates a
timestamped backup at `~/.zshrc.zodex.bak.${Date.now()}`. There is no cap or
rotation. A user who runs `zodex install` frequently (or a script that does)
will accumulate unbounded `.zshrc.zodex.bak.*` files in `$HOME`. The
first-ever backup (`.zshrc.zodex.bak`) is intentionally stable for discovery,
but the timestamped copies have no cleanup.

Fix: keep only the N most recent timestamped backups (e.g. 5) by listing
matching files, sorting by timestamp suffix, and unlinking the oldest beyond
the cap. Or document that backups accumulate and provide a `zodex
install --clean-backups` flag.

---

## Prior finding resolution

### B1 — CRLF SSE framing (FIXED)
`src/responses.ts:721`

`parseChatCompletionSse` now normalizes CRLF to LF on every append:
`buffer = buffer.replace(/\r\n/g, "\n")` before scanning for `\n\n`. Verified
empirically with CRLF-framed events (`\r\n\r\n`) and with CRLF split across
chunk boundaries (`...\r` in one chunk, `\n\r\n...` in the next). Both cases
parse correctly. The test at tests/responses.test.ts:709 (`parses CRLF-framed
SSE events`) pins the behavior.

### W1 — `fail()` leaves in-progress items dangling (PARTIALLY FIXED)
`src/responses.ts:373-385`, `391-496`

`fail()` now calls `closeOpenItems(true)` before emitting `response.failed`,
closing text items (with `content_part.done` + `output_item.done`), tool
items (with `function_call_arguments.done` + `output_item.done`), and
reasoning items (with `reasoning_summary_text.done` + `output_item.done`).
Verified: the text and tool paths are balanced. The reasoning path is missing
`reasoning_summary_part.done` — see B2 above. `finish()` on the success path
is unchanged in behavior (it now routes through the same `closeOpenItems`
helper). Marked partially fixed; B2 is the remaining gap.

### W2 — Non-streaming upstream body parse unguarded (FIXED)
`src/server.ts:386-400`

The `await upstream.json()` call is now wrapped in `try/catch` and returns a
`502` with a Responses error envelope (`errorResponse(body, 502, ...)`) on
parse failure, with a `response.non_stream.parse_failed` debug log entry.
The success path is unchanged.

### W3 — Streaming error returns HTTP 200 with `response.failed` body (CONFIRMED DELIBERATE)
`src/server.ts:209`, `233`, `351`

No change needed — this is the correct Responses streaming contract (terminal
SSE event, not HTTP status). With B2 fixed, in-progress items will be closed
before `response.failed`.

### W4 — Concurrent `install` races on `~/.zshrc` (FIXED)
`src/install.ts:97-132`, `391-409`, `423-431`

Both `install` and `uninstall` now wrap their `.zshrc` read-modify-write in
`withFileLock`, an advisory `O_EXCL` lockfile at `${targetPath}.zodex.lock`.
The lock retries for ~5s and falls back to proceeding without the lock if it
can't be acquired. Verified: the lock is acquired, the RMW is serialized, and
the lock is released in `finally`. See N9 for the stale-lockfile edge case.

### W5 — Backup is stale on rerun (FIXED)
`src/install.ts:398-406`

The first-ever backup (`.zshrc.zodex.bak`) is kept stable for discovery. A
fresh timestamped backup (`.zshrc.zodex.bak.${Date.now()}`) is created on
every install that actually changes the content. When the install is a
no-op (`updatedZshrc === currentZshrc`), no backup or write occurs (the
idempotent short-circuit at install.ts:395-396). Verified empirically: second
install with no changes creates no new backup; third install with a changed
bin creates a new timestamped backup. See N10 for unbounded accumulation.

### W6 — `repairJsonArguments` silent corruption (FIXED via logging)
`src/responses.ts:459-470`

`closeOpenItems` now logs a `tool.arguments.repaired` trace event with the
original and repaired lengths when `repairJsonArguments` returns a different
string. The repair itself is conservative (returns original on any parse
failure), so the logging is the correct fix for diagnosability.

### N1 — Missing tool-call `id` in non-streaming output (FIXED)
`src/responses.ts:147`

`chatCompletionToResponse` now synthesizes `call.id || toolCallId()` when the
upstream omits the id, matching the streaming path. The test at
tests/responses.test.ts:590 pins the behavior. `id` and `call_id` are both set
to the synthesized value.

### N2 — `model` unconditionally lowercased (FIXED via logging)
`src/translate.ts:352-363`

The lowercasing is preserved (Z.AI expects lowercase), but a
`request.model.lowercased` trace event is now logged when the lowercasing
actually changes the id, with the original and forwarded values. A 404 from
a case-sensitive upstream is now diagnosable.

### N3 — `content-length` header logging (FIXED)
`src/server.ts:162`

The field is renamed to `content_length_header` to distinguish it from
`body_bytes`, which logs the actual `rawBody` size. This is the exact fix
suggested in the prior review.

### N4 — `ensureToolOutputsHaveCalls` O(n²) scan (FIXED)
`src/translate.ts:307-345`

The method now tracks `lastAssistant` as it builds `result` and checks
`tool_calls` on that one entry in O(1), instead of reversing and rescanning
the entire prefix per tool message.

### N5 — `appendMessage` coalescing (FIXED)
`src/translate.ts:70-89`

The coalescing condition no longer requires `last.tool_calls` to be truthy.
An incoming `function_call` (assistant with `tool_calls` and no content) now
coalesces onto any preceding assistant message — whether it has prior
`tool_calls` (parallel calls) or string content. Verified empirically: an
assistant text message followed by a `function_call` coalesces into one
message with both content and tool_calls.

### N6 — `firstToolName` fallback (ACKNOWLEDGED with comment)
`src/translate.ts:324-338`

The code now has a comment explaining the rationale (using a declared
function tool name so upstreams that validate tool_call names don't reject
the synthesized call). The behavior is unchanged. No debug warning was added,
but the comment documents the design choice.

### N7 — `filter(Boolean)` on output (ACKNOWLEDGED with comment)
`src/responses.ts:362-363`

The `filter(Boolean)` is kept with a comment explaining it is defensive and
that the success path has no holes. No behavior change.

### N8 — Debug `summarizeChatRequest` double serialization (ACKNOWLEDGED)
`src/server.ts:125`

No change. Noted as acceptable since it only runs when debug is enabled.

### T1 — `decodeEvents` strips `[DONE]` (FIXED)
`tests/responses.test.ts:283-297`

A new test (`terminates with response.completed then a [DONE] marker`) asserts
the raw stream ends with `data: [DONE]\n\n` and that `response.completed` is
the last JSON event, using `rawText(chunks)` not the filtered `decodeEvents`
helper. The helper itself is unchanged (still filters `[DONE]`), but the
terminal-event ordering is now pinned by a test that would fail if `[DONE]`
were dropped.

### T2 — No test for `fail()` / `content_filter` (FIXED)
`tests/responses.test.ts:411-468`, `473-487`

Three new tests cover the failure paths: `closes in-progress items when the
stream fails mid-flight` (fail after partial text, asserts `output_item.done`
before `response.failed`, asserts `incomplete` status), `content_filter
finish_reason yields response.failed, not completed`, and `stop finish_reason
completes normally`. A separate test (`fail() emits response.failed with the
error envelope and [DONE]`) pins the fail-only path. These would fail if the
failure event shaping or `content_filter` routing regressed.

### T3 — Reasoning completion events not asserted (FIXED, but test is incomplete)
`tests/responses.test.ts:300-322`

The new test `emits the full reasoning summary event lifecycle` asserts
`toContain` for `reasoning_summary_part.added`, `reasoning_summary_text.delta`,
`reasoning_summary_text.done`, and `output_item.done`. This would catch a
regression that dropped `reasoning_summary_text.done` or `output_item.done`.

However, the test does not assert `reasoning_summary_part.done` — because the
code does not emit it (B2). The test uses `toContain` (unordered), so it also
does not verify the event sequence. A regression that emitted
`reasoning_summary_part.done` out of order (e.g. after `output_item.done`)
would still pass.

### T4 — No test for `output_item.done` on text/tool items (FIXED)
`tests/responses.test.ts:326-363`

The new test `emits output_item.done for text and tool-call items` asserts
that `output_item.done` events are present for both `message` and
`function_call` items, with valid `output_index` and `item.id`. This would
catch a regression that dropped the intermediate done events.

### T5 — Idle-timeout test uses `toContain` (FIXED)
`tests/responses.test.ts:684-705`

A new test (`idle timeout throws an exact message and ends the iterator`)
asserts the full message with `toBe` (not `toContain`) and asserts the
iterator's `done` state after the throw. The original `toContain` test is kept
for redundancy.

### T6 — `retryDelayMs` HTTP-date format (FIXED)
`tests/install.test.ts:165-168`

A new test pins the HTTP-date fallback: `retryDelayMs("Wed, 21 Oct 2025
07:28:00 GMT", 0)` returns `500` and `..., 2)` returns `2000`.

### T7 — `upsertMarkedBlock` surrounding content (FIXED)
`tests/install.test.ts:131-135`

The double-upsert test now asserts `second.toContain("export PATH=/bin")` and
that the `export PATH` line appears before the managed block.

### T8 — Non-streaming tool call with missing `id` (FIXED)
`tests/responses.test.ts:590-614`

A new test (`synthesizes an id for a non-streaming tool call missing one`)
asserts the `function_call` item has a non-empty `id` and that `call_id === id`.

### T9 — Multiple/parallel tool calls (FIXED)
`tests/responses.test.ts:366-407`

A new test (`handles multiple parallel tool calls in a single chunk`) feeds
two tool calls (indices 0 and 1) and asserts both appear in `output` with
correct names and arguments. This exercises the `toolIdByIndex`/`toolsById`
machinery for multiple concurrent tools.

### T10 — `decodeEvents` reimplements SSE framing (ACKNOWLEDGED, low priority)
`tests/responses.test.ts:15-20`

The helper is unchanged. The B1 test (`parses CRLF-framed SSE events`) tests
`parseChatCompletionSse` directly (the production parser), not through
`decodeEvents`, so the framing-bug blind spot is mitigated for the CRLF case.

---

## Summary

The prior round's fixes are substantively correct. B1 (CRLF framing) is
verified fixed across chunk boundaries. W2, W4, W5, W6, N1–N4, N6–N8, and all
test gaps T1–T10 are resolved. The install locking and backup logic is
correct and idempotent.

One prior finding is not fully resolved: W1 (dangling in-progress items) is
fixed for text and tool items but not for reasoning items. The reasoning path
emits `reasoning_summary_part.added` without a matching
`reasoning_summary_part.done` in both the success and failure paths. This is
B2. The T3 test that was added to cover the reasoning lifecycle does not
catch it because the code never emits the event and the test does not assert
it.

Two new minor issues emerged from the re-review: `finish()`/`fail()` lack
idempotency guards (W7, latent but unguarded in the public API), and the
install lockfile has no stale-lock cleanup (N9) or backup rotation (N10).
Neither blocks current usage, but both are worth addressing.

VERDICT: FIXES_REQUIRED
