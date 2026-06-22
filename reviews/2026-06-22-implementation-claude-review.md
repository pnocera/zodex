# Review — zodex implementation milestone (Codex → Z.AI GLM 5.2 gateway)

The install/profile-wiring blockers from the design review (F1/F2) are **resolved and verified** against the actually-installed Codex (`@openai/codex` 0.141.0): `-p, --profile <name>` is documented as *"Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config,"* and `--dangerously-bypass-approvals-and-sandbox` exists. So the "modern profile-file" approach is manual-grounded for this version, and `config.toml` is correctly left untouched. The translation/streaming core is well structured. However, two latent correctness bugs sit on the **main request/response path** and are not covered by the tests or the smoke validation (which exercised the bridge directly, not a real Codex run).

## 1. Findings (ordered by severity)

### F1 — [High] Cumulative-delta heuristic silently truncates legitimate repeated content (text **and** tool args)
**Reason:** `computeAppendDelta` (`src/translate.ts`… actually `src/responses.ts:132-148`) treats any incoming delta that equals the accumulated prefix — or is a trailing-overlap of it — as a duplicate and drops it. If Z.AI streams **incrementally** (the OpenAI-compatible default; the smokes can't disambiguate because non-repeating text behaves identically either way), this corrupts output. Reproduced against the real `ResponsesStreamTranslator`:
- deltas `["ha","ha","ha"]` → final text `"ha"` (expected `"hahaha"`)
- `["ab","ab"]` → `"ab"`; `["the ","the "]` → `"the "`
Both the `startsWith` branch (139-141) and the suffix-overlap loop (142-146) cause the drop. The same function feeds `toolDelta` (498), so tool-call arguments with repeated fragments can be silently mangled — a coding agent then executes a tool with wrong/short arguments and no error surfaces.
**Fix:** Detect cumulative mode strictly and stop guessing per-delta: treat as cumulative only when `incoming.length > current.length && incoming.startsWith(current)` → return `incoming.slice(current.length)`; otherwise append `incoming` verbatim. Drop the suffix-overlap heuristic (the source of the worst false positives). Confirm Z.AI's actual streaming mode and add a regression test with repeated tokens.

### F2 — [High] `reasoning_effort` is sent as an object on the main path; Codex requests routinely trigger it
**Reason:** `translate.ts:331-339` sets `translated.reasoning_effort = reasoning.summary !== undefined ? reasoning : reasoning.effort`. Codex 0.141.0 sends `reasoning: { effort, summary }` (summary defaults to `"auto"`) on real Responses requests, so the common branch forwards the **whole object** to Z.AI's `/chat/completions`, where `reasoning_effort` is a string enum. Reproduced:
- `reasoning:{effort:"medium",summary:"auto"}` → `reasoning_effort = {"effort":"medium","summary":"auto"}`
- `reasoning:{effort:"high"}` → `reasoning_effort = "high"` (correct only when summary is absent)
At best upstream ignores the malformed field (reasoning effort silently lost); at worst it 400s every real Codex request. The direct-to-bridge smokes didn't set `reasoning`, so this path is untested.
**Fix:** Always forward the string: `translated.reasoning_effort = reasoning.effort` (when it's a string/defined), and drop `summary` (no chat-completions equivalent). Verify with a live reasoning request through Codex, not a crafted payload.

### F3 — [Medium] 429 backoff collapses to 0 ms when `Retry-After` is absent
**Reason:** `upstream.ts:76-79`: `Number(response.headers.get("retry-after"))` is `Number(null) === 0` when the header is missing; `Number.isFinite(0)` is `true`, so the intended `500 * 2**attempt` fallback never runs and the loop retries immediately (3 tight retries), defeating the limiter on real rate-limit responses.
**Fix:** Guard for missing/invalid header explicitly, e.g. `const ra = response.headers.get("retry-after"); const secs = ra == null ? NaN : Number(ra);` then branch on `Number.isFinite(secs) && secs > 0`.

### F4 — [Low/Medium] Global `RateLimiter` singleton serializes all concurrent requests
**Reason:** `upstream.ts:22` instantiates one module-level limiter at 200 ms; with `parallel_tool_calls` or concurrent sessions every upstream call is serialized 200 ms apart. Fine for single-user local use, but it's hidden global state with no config knob and uses `Date.now()` directly.
**Fix:** Make the interval configurable (env) and document it; acceptable to keep for v1, just call it out.

### F5 — [Low] Reasoning streamed as `response.reasoning_text.*` but the item is built as a `summary[]`
**Reason:** `responses.ts` emits `response.reasoning_text.delta/done` (444, 271) while the stored item uses `summary: [{type:"summary_text", …}]` (280). The OpenAI Responses summary stream normally uses `response.reasoning_summary_text.*`. If Codex's strict SSE deserializer expects the summary variant, live reasoning text may not render mid-stream (the final item still carries it). Not load-bearing for tool execution, but worth confirming against the Codex deserializer.
**Fix:** Confirm which event family Codex 0.141.0 consumes for summaries; align the event name or the item shape.

### F6 — [Low] Installer hardening gaps and a hard-coded default path
**Reason:** `install.ts:89` defaults `zodexBin` to `"/home/pierre/Tools/codex-bridge/zodex/bin/zodex"` (machine-specific; only a fallback since the CLI always passes `preferredInstallBin()`, but it's a non-portable smell). The `.zshrc` edit is correctly idempotent/marked, but there's no backup, no atomic temp-and-rename, no `uninstall` to remove the block, and no reminder to `export ZAI_API_KEY` (README covers it; the `install` output doesn't). Codex's `env_key` means a missing key fails Codex-side before the bridge is reached.
**Fix:** Derive the default from `import.meta`/cwd or require the arg; back up + atomic-write `.zshrc`; add `uninstall`; have `install` print the export reminder.

### F7 — [Low] Test coverage misses every behavior these findings touch
**Reason:** Tests (`tests/*`) cover happy-path translate/stream/install helpers only — 10 tests, all green. Nothing exercises: incremental repeated-delta handling (would catch F1), `reasoning_effort` mapping (F2), JSON-argument repair, `content_filter` → `response.failed`, `ensureToolOutputsHaveCalls`, upstream-error → `response.failed`, 429 retry, or the server router. `install()` itself (FS writes) is untested; only `codexProfileToml`/`upsertMarkedBlock` are.
**Fix:** Add unit tests for the above, especially F1/F2 regressions, and a temp-dir test for `install()`.

## 2. Open questions / residual risks
- **Z.AI streaming mode (cumulative vs incremental).** F1's severity hinges on this; the smokes don't disambiguate. Please confirm with a repeated-token streaming response (e.g. ask the model to print `ha ha ha ha`).
- **Does Z.AI's `paas/v4/chat/completions` accept/ignore/reject `reasoning_effort`, and as what type?** Drives F2. Test a real reasoning-enabled Codex turn end-to-end.
- **End-to-end Codex path was not in the validation list.** All live smokes hit `./dist/zodex` directly; no `codex --profile zai-glm52` run is recorded. That's exactly where F2 (and F5) would surface. Recommend one real `cxz` session before shipping.
- **`cx` alias still strips the sandbox from the default profile** (prior F3). User-requested and accepted, but installing zodex changes normal Codex safety globally — keep the printed warning; consider leaving `cx` sandboxed and scoping the bypass to `cxz`.
- **Bridge is unauthenticated.** Mitigated by `127.0.0.1` binding; any local process can spend the key. Acceptable for local dev; note it.

## 3. Verification notes
- Read all source (`src/*.ts`), `index.ts`, `bin/zodex`, tests, `docs/design.md`, `README.md`, `package.json`, `.gitignore`, and the prior design review.
- **Confirmed against installed Codex 0.141.0** (`@openai/codex`, real OpenAI CLI): `--profile` *"Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config"* and `--dangerously-bypass-approvals-and-sandbox` both exist → prior F1/F2 blockers genuinely resolved; the sibling-profile-file design is correct for this version, and `config.toml` is layered (not overwritten).
- Re-ran `bun run typecheck` (exit 0) and `bun test` (10 pass / 0 fail).
- **Reproduced F1** via the real `ResponsesStreamTranslator`: `["ha","ha","ha"]`→`"ha"`, `["ab","ab"]`→`"ab"`, `["the ","the "]`→`"the "`, while `["x","y","z"]`→`"xyz"` (non-repeating is fine).
- **Reproduced F2** via `translateResponsesRequest`: object emitted whenever `reasoning.summary` is present (incl. `summary:null`).
- F3 confirmed by reading (`Number(null)===0` is finite). Did not place live Z.AI calls (no key in this review) — F1/F2 upstream impact remains contingent on Z.AI behavior as noted.
- No files edited; throwaway probes were run from `/tmp` and removed. Empty `reviews/…implementation-claude-review.md.tmp` left untouched.

The prior blockers are cleared and the architecture is sound, but F1 and F2 are real, reproducible defects on the primary path that neither the test suite nor the recorded smokes exercise — they should be fixed (or upstream-verified) and a real end-to-end Codex run added before the install/alias step.

VERDICT: FIXES_REQUIRED
