## Review: zodex debug-mode diff

### 1. Findings (by severity)

**[High] Non-debug path does full payload serialization on every request — violates "keep normal operation lightweight."** `src/server.ts:158,180` and `src/server.ts:120`. The arguments to `debug.log(...)` are evaluated eagerly, *before* the logger's `if (!config.enabled) return` guard ever runs. So even with debug off, every `/responses` request pays:
- `encodedLength(rawBody)` → a full `TextEncoder().encode()` of the raw request body (`server.ts:158`),
- `summarizeChatRequest(translated)` → `encodedLength(JSON.stringify(translated))` (`server.ts:120`), i.e. a full `JSON.stringify` of the entire translated payload (whole conversation + tools) *plus* a second `TextEncoder` pass.

For Codex traffic these payloads are large, and this is pure waste in the default mode. The original code did none of it. Guard the heavy bits behind `debug.enabled` (or pass thunks / let `debug.log` accept a lazy builder). `summarizeChunk(chunk)` at `server.ts:~258` is also called per-chunk unconditionally, though it's cheap.

**[Medium] Debug silently no-ops when a non-debug bridge is already running — undercuts the "must work when auto-started detached by `zodex codex`" requirement.** `src/cli.ts:202-206` (`runCodex`). Debug is only honored if `healthcheck` fails and `spawnDetachedServer(env)` actually launches a fresh server carrying `ZODEX_DEBUG`. The detached server is persistent across invocations, so the common sequence — plain `zodex codex …` (starts a non-debug server), then later `zodex codex --zodex-debug …` — finds the server healthy, reuses it, and never logs anything. Request handling lives in the detached server, not the codex process, so the flag has no effect. Worse, `runCodex` still prints `zodex debug log: ~/.zodex/debug.log` (cli.ts:197), so the user tails an empty file precisely when they need evidence. The README (`README.md`, "already running…") explains why file logging matters but never warns that debug won't activate against a stale server. Cold-start (your port-31453 validation) works; the reuse case does not. Consider detecting a running-but-non-debug server and restarting it, or at minimum print a "reusing existing server; debug may be inactive" caveat.

**[Low-Med] `zodex serve --debug` (trailing flag) silently ignores `--debug`.** `src/cli.ts:227-237`. `parseLeadingOptions` stops at the first non-option token, which is the command; flags placed *after* `serve` are never parsed and `serve` ignores extra argv. Only `zodex --debug serve` works. It's what the usage text shows, but `serve --debug` is the more natural form and fails with no error.

**[Low] Trace-mode logging does synchronous disk I/O per event, perturbing the timing being measured.** `src/debug.ts:96-111`. `write()` runs `mkdirSync(...)` *and* `appendFileSync(...)` on every log line, on the event loop. In trace mode `upstream.sse.raw_chunk` fires per raw chunk (`responses.ts:~590`), so every streamed chunk blocks on a sync `mkdir`+`append`. That can distort the very stall/latency diagnostics this feature exists to capture. `mkdirSync` per line is also redundant (do it once at logger creation).

**[Low] CLI space-form value flags can swallow a Codex arg.** `src/cli.ts` `parseCodexOptions` (`--zodex-debug-file`, `--zodex-stream-idle-timeout-ms`, `--zodex-upstream-fetch-timeout-ms`) do `i += 1; env.X = args[i]` unconditionally. `zodex codex --zodex-debug-file exec "…"` consumes `exec` as the path and drops it from the forwarded args. The `=` form is safe. Same shape exists in `parseLeadingOptions`. Lower-risk than it sounds (only `--zodex-*`/leading `--*` tokens are touched, so genuine Codex flags are never consumed unless they directly follow a value-flag), but it's exactly the "accidental consumption" footgun you called out. Relatedly, `numberFromEnv` (`src/upstream.ts:28-40`) silently falls back to default on non-numeric input — `--upstream-fetch-timeout-ms 50ms` parses to NaN → default, with no error surfaced.

**[Low] Redaction is key-name based only.** `src/debug.ts:75-90`. Solid for current logs (the `authorization` header and `config.apiKey` are never logged as values, the upstream URL carries no key, and `max_output_tokens`/`max_tokens` correctly survive since they end in `_tokens` not `_token`). The residual risk is value-embedded secrets: if a future change logs an `error`/`text` string that contains `Bearer …`, the key-based filter won't catch it. No leak today; flag as a latent invariant.

### 2. Open questions / residual risks

- **Non-stream body hang is uninstrumented.** The fetch timeout covers only time-to-headers (correctly documented in the README), and the idle timeout covers only the SSE path. A non-stream response whose headers arrive then whose body stalls hangs forever in `await upstream.json()` (`server.ts:330`) with no timeout and no diagnostic. Codex mostly streams, so low severity, but it's a blind spot for "Codex goes quiet."
- **SSE idle-timeout race relies on cancel() resolving (not rejecting) the losing read.** `responses.ts:629-663`. When the timer wins `Promise.race`, the still-pending `reader.read()` is never awaited; correctness depends on `reader.cancel()` settling it as `{done:true}` rather than rejecting (which would be an unhandled rejection). Spec-compliant and your live test didn't trip it, but it's implementation-dependent. A chunk that arrives in the same tick as the timeout is also silently dropped — acceptable for a timeout path.
- **Client-disconnect during stream.** The new `cancel(reason)` handler (`server.ts:~333`) only logs; it doesn't abort the upstream read, so on client disconnect the `for await` keeps draining upstream while `controller.enqueue` throws into the catch→`fail()`→`enqueue` path. Pre-existing behavior, not introduced here, but the new cancel hook is where an `AbortController`/early-return could fix it.
- **`Buffer.byteLength(body)` in `upstream.fetch.start`** (`upstream.ts`) is also eagerly evaluated per attempt regardless of debug state — minor, same class as finding #1.

### 3. Verification notes

- Re-derived behavior from the diff + current `cli.ts`/`server.ts`/`responses.ts`/`upstream.ts`/`debug.ts`; did not run the suite (read-only review).
- Confirmed `translator.fail()` (`responses.ts:408`) is self-contained (`response.failed` + `[DONE]`), so the new upstream-fetch-failed streaming path (`server.ts:194-210`) is consistent with the existing `!upstream.ok` path.
- Confirmed timeout cleanup: per-attempt `AbortController` + `clearTimeout` in `finally` on both success and throw — no timer leak, no cross-attempt bleed; abort errors exit the retry loop (not retried), which is reasonable.
- Confirmed redaction by inspection and against `tests/debug.test.ts`: `authorization`/nested `api_key` redacted, `max_output_tokens` preserved. No path logs the API key, auth header, or `process.env`.
- Confirmed non-debug defaults: both timeouts default to `0` (off) unless debug is on or env vars are set — preserves non-debug behavior except the explicit env knobs, as intended.
- **Test gaps that matter:** no coverage of `parseLeadingOptions`/`parseCodexOptions` despite the explicit Codex-arg-consumption concern (both are unexported — would need exporting to test); no unit test for the fetch-timeout abort in `fetchChatCompletions` (live-only); no test for the streaming `upstream-fetch-failed → response.failed` path; no test asserting non-debug mode writes no file / skips summarization. The CLI parsing gap is the one I'd most want closed before merge.

### 4. Verdict

FIXES_REQUIRED

Primary: guard the per-request `JSON.stringify(translated)` / `encodedLength(rawBody)` / summarization behind `debug.enabled` (finding #1) — it violates the stated "keep normal operation lightweight" requirement and is a trivial fix. Strongly recommended before merge: handle or document the stale detached-server case so `--zodex-debug` doesn't silently produce an empty log (finding #2), and add CLI flag-parsing tests. The timeout/cancellation and redaction logic itself is sound.
