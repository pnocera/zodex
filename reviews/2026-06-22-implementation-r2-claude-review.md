All prior blockers verified fixed, validation reproduced, no files edited, no stray artifacts. Here is my review.

---

# Review — zodex fixed implementation milestone (Codex → Z.AI GLM 5.2)

All six blockers/findings from `reviews/2026-06-22-implementation-claude-review.md` are resolved and independently reproduced. The prior FIXES_REQUIRED defects on the main path (F1 delta truncation, F2 `reasoning_effort` object, F3 429 backoff) are genuinely fixed, with regression tests added, and a real end-to-end `cxz` run is now recorded — which closes the prior review's single biggest gap. The remaining findings below are all **Low / accepted residuals**; none is a correctness blocker.

## 1. Findings (ordered by severity)

### F1 — [Low] Non-standard SSE event names for reasoning and tool-call name (Codex deserializer risk)
**Reason:** The translator emits `response.reasoning_text.delta`/`.done` (`src/responses.ts:297,470`) and `response.function_call_name.done` (`src/responses.ts:515`). The OpenAI Responses summary stream conventionally uses `response.reasoning_summary_text.*`, and there is no standard `response.function_call_name.done` event. If Codex 0.141's SSE deserializer is strict, a reasoning-bearing or tool-calling turn could be rejected mid-stream. This is mitigated because the reasoning content and the tool name are also delivered in the final `response.output_item.done` / `response.completed` items, which Codex reads regardless — so worst case is loss of mid-stream rendering, not loss of the final result. The recorded end-to-end smoke ("Reply exactly OK. Do not run commands") exercised only the plain-text event set, so these two event families remain unverified against real Codex.
**Fix:** Run one real `cxz` turn that produces reasoning and one that triggers a tool call; if Codex ignores the extra events, leave as-is, otherwise align reasoning to `response.reasoning_summary_text.*` and drop `function_call_name.done`.

### F2 — [Low] `computeAppendDelta` resolves the incremental/cumulative ambiguity toward cumulative
**Reason:** `src/responses.ts:166-174` treats `incoming` as cumulative whenever `incoming.length > current.length && incoming.startsWith(current)`. This is the recommended fix and is correct for the repeated-token cases that broke before (verified: `["ha","ha","ha"]→"hahaha"`, `["ha","haha","hahaha"]→"hahaha"`, plus genuine cumulative `["He","Hell","Hello"]→"Hello"`). The only residual false-merge is a genuinely incremental delta that is strictly longer than the entire accumulated text *and* starts with it (e.g. accumulated `"hi"`, next incremental delta `"hi there"` → merged instead of appended). This is rare in practice and was the explicitly accepted tradeoff.
**Fix:** None required. If Z.AI's stream mode is ever confirmed strictly incremental, the `startsWith` cumulative branch could be removed entirely; until then keep as-is.

### F3 — [Low] Responses-only / custom tool definitions are silently dropped (no count logged)
**Reason:** `normalizeTools` (`src/translate.ts:147-179`) correctly drops every non-`function` tool container (test at `tests/translate.test.ts:87-103`). This is the right behavior for a Chat Completions upstream, but `type: "custom"` (freeform) tools and built-in tool types (e.g. `local_shell`, `web_search`) are removed without any debug note. If Codex ever sends a tool only in one of those shapes, the model would silently lose that capability. Codex 0.141's default profile uses function-style tools, so this is currently latent.
**Fix:** Optional — emit a `debugLog` with the count/types of dropped tool containers so a future Codex change that relies on a non-function tool is diagnosable.

### F4 — [Low] Global `RateLimiter` singleton (200 ms) still serializes concurrent upstream calls; no env knob
**Reason:** `src/upstream.ts:22` keeps a module-level limiter; `parallel_tool_calls` or concurrent sessions are serialized 200 ms apart, and the interval isn't configurable. Prior review accepted this for single-user v1.
**Fix:** Optional — expose the interval via an env var and document it; acceptable to ship as-is.

### F5 — [Low] `Retry-After` HTTP-date form not honored
**Reason:** `retryDelayMs` (`src/upstream.ts:41-48`) parses `Retry-After` only as a numeric seconds value; an HTTP-date form parses to `NaN` and falls back to exponential backoff. Correct and safe (the fallback is sane), just not spec-complete.
**Fix:** Optional — parse the date form with `Date.parse` and clamp; not needed for Z.AI.

## 2. Open questions / residual risks
- **Reasoning + tool-call streaming vs Codex's SSE deserializer (F1).** The recorded smoke didn't produce reasoning or a tool call. Recommend two real `cxz` turns — one reasoning-heavy, one that calls a tool — before declaring full Responses fidelity. This is the only residual that could, in principle, surface as a hard failure.
- **`cx` alias globally disables Codex sandbox/approvals.** Unchanged from prior review; user-requested and now accompanied by a printed warning and an export reminder. Consider leaving `cx` sandboxed and scoping the bypass to `cxz` only.
- **Bridge is unauthenticated** (mitigated by `127.0.0.1` bind). Any local process can spend the key. Acceptable for local dev.
- **`zodex build` from the compiled binary** spawns `bun` (`src/cli.ts:122`), which won't exist on PATH in a pure-binary deployment. Harmless (you build with Bun, not the binary), worth a doc note only.
- **Model name `glm-5.2`** is taken on faith; the recorded end-to-end smoke returning `OK` with `turn.completed` indicates Z.AI accepts it through the full pipeline, so this is effectively confirmed.

## 3. Verification notes
- Read all sources (`src/*.ts`, `index.ts`, `bin/zodex`), all tests, `docs/design.md`, `README.md`, `package.json`, and the prior review.
- `bun run typecheck` → exit 0. `bun test` → **17 pass / 0 fail**.
- Built artifact present: `dist/zodex`, 94 MB self-contained ELF executable.
- Ran the **compiled binary** on isolated ports: `/health`, `/v1/models`, 404 routing, and missing-key paths all behave correctly; `serve` logs the listen line. The detached-server path (`serverCommand` for a non-`bun` execPath) resolves correctly to `./dist/zodex serve`.
- **F1 reproduced fixed** via the real `ResponsesStreamTranslator`: incremental `["ha","ha","ha"]→"hahaha"`, cumulative `["He","Hell","Hello"]→"Hello"`, normal incremental `["He","llo"," wo"]→"Hello wo"`, cumulative-with-repeats `["ha","haha","hahaha"]→"hahaha"`.
- **F2 (effort)** confirmed: `reasoning:{effort:"medium",summary:"auto"}` → `reasoning_effort:"medium"` (test + code at `translate.ts:332-341`).
- **F3 (429)** confirmed: `retryDelayMs(null,0)=500`, `retryDelayMs("",1)=1000` (the `> 0` guard handles `Number("")===0`), `retryDelayMs("2",1)=2000`.
- **Usage normalization** applied on both non-streaming (`chatCompletionToResponse`) and streaming (`finish()` → `responseObject` → `normalizeUsage`) paths; verified the failed/error envelope shape (`status:"failed"`, `usage:null`) for both `stream:false` (JSON 401) and `stream:true` (well-formed `response.failed` SSE + `[DONE]`, HTTP 200).
- **Installer** read-confirmed: atomic temp-and-rename (`writeAtomic`), one-time `.zshrc.zodex.bak` backup, conflict warnings, `uninstall` via `removeMarkedBlock` (test-covered), `import.meta`-derived default bin (no hard-coded path), and printed bypass + `ZAI_API_KEY` export reminders.
- No files edited; throwaway probe written inside the repo and removed — `git status` clean of artifacts, no stray temp files.

The prior blockers are genuinely cleared, validated by the test suite, a live binary run, and the user's recorded end-to-end `cxz` smoke. The only residual worth a quick live check before broad use is reasoning/tool-call SSE acceptance by Codex (F1), and even that degrades gracefully because the final response items carry the content. No correctness blockers remain.

VERDICT: GO
