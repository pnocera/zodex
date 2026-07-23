# zodex re-review (round 3) — 2026-07-23

Independent re-verification of the working tree against the round-2 review
(`reviews/2026-07-23-zodex-codex-review-r2.md`, verdict `FIXES_REQUIRED`). Every
round-2 finding — B2, W7, N9, N10 — was re-checked against the current source
by reading the code, running the test suite, and probing the runtime behavior
with targeted scripts. `bun run typecheck` and `bun test` (55 pass / 0 fail
across 5 files) reproduced green locally.

Findings are grouped BLOCKER / WARN / NIT, each with `file:line` and a concrete
fix. The "Round-2 finding resolution" section confirms each prior finding.
The verdict is at the end.

---

## BLOCKER

None.

---

## WARN

None.

---

## NIT

### R3-N1 — No regression test for the stale-lockfile reclamation path (N9 fix)
`src/install.ts:96-121` (`lockIsStale`), `src/install.ts:130-170` (`withFileLock`)

The N9 fix is correct by code inspection (verified below), but neither
`lockIsStale` nor the `withFileLock` reclaim branch is exercised by any test.
Both are private (not exported), and exercising the reclaim path requires a
pre-existing lockfile containing a dead pid — a setup the install tests don't
construct. A regression that always returned `false` from `lockIsStale`
(reverting to the original "always wait the timeout" behavior) would pass the
suite silently.

Fix: export `lockIsStale` (or add a thin test seam) and add a test that writes
a lockfile with a pid that is guaranteed dead (e.g. a very large pid, or spawn
a child and kill it), then asserts `withFileLock` proceeds without the 5s
delay. Alternatively, test `lockIsStale` directly against a live pid (self)
returning false and a dead pid returning true.

---

## Round-2 finding resolution

### B2 — `reasoning_summary_part.added` now paired with `reasoning_summary_part.done` (FIXED)
`src/responses.ts:419-426`

`closeOpenItems` now emits `response.reasoning_summary_part.done` (line 419)
after `reasoning_summary_text.done` (line 407) and before `output_item.done`
(line 433), in both the `finish()` and `fail()` paths. Verified empirically:

```
=== Success: reasoning lifecycle ===
  response.created
  response.in_progress
  response.output_item.added
  response.reasoning_summary_part.added
  response.reasoning_summary_text.delta
  response.reasoning_summary_text.done
  response.reasoning_summary_part.done   ← now present
  response.output_item.done
  response.completed
  part.added=1 part.done=1 balanced=true

=== Failure: reasoning + fail ===
  (same prefix)
  response.reasoning_summary_part.done   ← now present
  response.output_item.done
  response.failed
  part.added=1 part.done=1 balanced=true
```

The ordering mirrors the text path (`output_text.done` → `content_part.done` →
`output_item.done`) and matches the OpenAI Responses event contract. Two tests
pin the behavior: `emits the full reasoning summary event lifecycle in order`
(tests/responses.test.ts:301) asserts presence and ordering of
`reasoning_summary_part.done` in the success path, and `closes the reasoning
summary part when the stream fails` (tests/responses.test.ts:333) asserts
exactly one `added` and one `done` in the failure path. Both would fail if the
emit were removed.

### W7 — `finish()`/`fail()` idempotency guard (FIXED)
`src/responses.ts:292` (`finished` field), `352-377` (`finish`), `380-396` (`fail`)

A `private finished = false` guard is set on the first terminal call and
checked at the top of both `finish()` (line 355) and `fail()` (line 381); a
second call returns `[]`. Verified empirically:

```
=== W7: idempotency ===
1st finish events=1  2nd finish events=0  fail-after-finish events=0
1st fail events=1    finish-after-fail events=0
```

The critical edge case — `finish()` with `this.failure` set (content_filter)
delegating to `fail()` — was checked specifically. `finish()` checks
`this.finished` (line 355) before the `if (this.failure)` delegation (line
358), and `fail()` sets `finished` (line 384) before calling `closeOpenItems`.
So the delegation produces exactly one terminal event, one `[DONE]`, and no
duplicate. Verified:

```
=== content_filter + double finish + fail ===
[DONE] markers: 1 (expect 1)
response.completed: 0 (expect 0)
response.failed: 1 (expect 1)
```

The guard cannot suppress the first legitimate terminal event because it is
set inside the body of the method that runs, not before the delegation. The
test `finish()/fail() are idempotent after the stream is finished`
(tests/responses.test.ts:521) asserts the second call returns `[]` in both
directions and would fail if the guard were removed.

### N9 — Stale lockfile reclamation (FIXED)
`src/install.ts:96-121` (`lockIsStale`), `130-170` (`withFileLock`)

`withFileLock` now writes `String(process.pid)` into the lockfile on creation
(line 139). On `EEXIST`, it calls `lockIsStale` (line 148), which reads the pid
and tests it with `process.kill(pid, 0)` (line 111). If the result is `ESRCH`
(no such process), the lock is reclaimed immediately without sleeping (line
149-151). The function is conservative in all ambiguous cases:

- Empty/unreadable lockfile → `false` (line 100-101), treated as live.
- Non-integer or non-positive pid → `false` (line 107-108), treated as live.
- `EPERM` from `process.kill` → `false` (line 113-119: only `ESRCH` returns
  true), correctly interpreted as "process exists but under another user."

This is the standard pid-based stale-lock pattern. Pid recycling (a new
process reusing a dead pid) is a theoretical false-negative but is the
accepted trade-off for this approach and is unlikely in practice. No
regression test exists — see R3-N1.

### N10 — Timestamped backup rotation (FIXED)
`src/install.ts:175-195` (`rotateBackups`), `469` (install call), `494` (uninstall call)

`rotateBackups(basePath, 5)` keeps only the newest 5 timestamped
`.zshrc.zodex.bak.<ts>` backups and never touches the stable suffix-less
base backup. The regex `/\.\d+$/` only matches numeric suffixes, correctly
excluding the stable base (`.zshrc.zodex.bak`, no suffix) and the lockfile
(`.zshrc.zodex.lock`, non-numeric). Verified the filter against realistic
filenames:

```
.zshrc.zodex.bak                  → NOT selected (stable base)
.zshrc.zodex.bak.1234567890123    → selected (timestamped)
.zshrc.zodex.bak.abc             → NOT selected (non-numeric)
.zshrc.zodex.bak.zodex.lock      → NOT selected (non-numeric)
```

Called with `keep: 5` in both `install` (line 469) and `uninstall` (line 494),
after creating the new timestamped backup. The test `rotateBackups prunes old
timestamped backups but keeps the base` (tests/install.test.ts:173) creates 4
timestamped backups plus the stable base, rotates with `keep: 2`, and asserts
exactly the base + the 2 newest remain. Would fail if the rotation logic or
regex regressed.

---

## Regression check

All round-1 and round-2 fixes that were already confirmed resolved remain
intact in the current working tree. The `git diff` from HEAD confirms the only
changes are the round-2 fixes (B2/W7/N9/N10) and the previously-verified
round-1 fixes (B1/W1-W6/N1-N8) — no unrelated churn was introduced.

- `parseChatCompletionSse` CRLF normalization (B1) — unchanged, still
  `buffer.replace(/\r\n/g, "\n")` at responses.ts:744.
- Non-stream parse try/catch (W2) — unchanged, server.ts:387-400.
- Install `withFileLock` wrapping (W4) — present, install.ts:454, 487.
- Timestamped backups + idempotent no-op (W5) — present, install.ts:458-471.
- `tool.arguments.repaired` logging (W6) — present, responses.ts:482-493.
- Non-stream tool-call id synthesis (N1) — present, responses.ts:147.
- Model lowercasing trace log (N2) — present, translate.ts:352-363.
- `content_length_header` rename (N3) — present, server.ts:162.
- `ensureToolOutputsHaveCalls` O(1) scan (N4) — present, translate.ts:307-345.
- Assistant coalescing (N5) — present, translate.ts:70-89. Verified
  empirically: assistant text + function_call coalesces into one message with
  both content and tool_calls.
- Test gaps T1-T10 — all prior fixes present and unchanged.

No new behavioral regressions were found in the streaming event lifecycle,
translate path, install path, or server error handling.

VERDICT: GO
