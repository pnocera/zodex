All checks confirm the fixes hold. Here is my re-review.

---

## 1. Findings (by severity)

No blockers remain. The two round-1 blockers are resolved; what's left is Low/residual, unchanged in severity from the first pass.

**[Resolved — was High] Eager per-request serialization is gone.** `debug.log` now short-circuits at `src/debug.ts:133` *before* evaluating the payload (`src/debug.ts:136` only calls the thunk after the `enabled`/`trace` guard). All heavy call sites pass builders: `request.received`/`body_bytes` (`server.ts:157`), `request.parsed`/`summarizeResponsesRequest` (`server.ts:177`), `request.translated`/`summarizeChatRequest`→`JSON.stringify(translated)` (`server.ts:182`), and `upstream.fetch.start`/`Buffer.byteLength` (`upstream.ts:116`). The per-chunk `summarizeChunk` is now inside `if (debug.enabled)` (`server.ts:268`). I enumerated every non-lazy `log` call (`server.ts`/`upstream.ts`) — all are constant-size or on error/once-only paths. Default mode does no extra serialization. ✔

**[Resolved — was Medium] Stale non-debug server no longer silently swallows debug.** `runCodex` compares running state via `debugConfigMatches` (`cli.ts:205-219`) and restarts through `POST /__zodex/shutdown` + `waitForStopped` when settings differ (`cli.ts:267-281`). When shutdown is refused it now warns instead of pretending (`cli.ts:273`). ✔

**[Resolved — was Low-Med] `zodex serve --debug` works** via the second parse pass at `cli.ts:313`, with an unknown-option error and a regression test (`cli.test.ts:24`). ✔

**[Low] `mkdirSync` moved to logger creation, but trace logging is still synchronous per line.** `mkdirSync` now runs once (`debug.ts:100-110`) — the redundant-per-line part is fixed. But `appendFileSync` still runs on the event loop for every event (`debug.ts:118`), so in `trace` mode `upstream.sse.raw_chunk` (`responses.ts:590`) still does a blocking write per raw chunk. Same Low severity as round 1; acceptable trade-off (ordering/simplicity), only affects trace mode.

**[Low] Space-form value flag still swallows the next token in `parseCodexOptions`.** `--zodex-debug-file exec "prompt"` consumes `exec` as the path (`cli.ts:118-121`; same shape for the two `*-timeout-ms` value flags and in `parseLeadingOptions`). The round-2 fix correctly stops consuming at the first non-`--zodex-*` token (`cli.test.ts:34` confirms), but that doesn't cover a value flag whose argument is missing/misused. The `=` form is safe and is what the README/smoke tests use. Footgun only on user misuse — not a blocker.

**[Low] `numberFromEnv` swallows non-numeric input.** `--zodex-upstream-fetch-timeout-ms=abc` → NaN → silent fallback to default (`upstream.ts:35-38`). Unchanged from round 1; no error surfaced. Low.

**[Low] Redaction remains key-name based** (`debug.ts:79-94`). No value-embedded-secret leak today; the only raw free-text logged is the upstream error `text` (`server.ts:218`, truncated to 2000 chars by `sanitize`), which comes from z.ai and is needed for the error response regardless. Latent invariant, not a leak.

## 2. Open questions / residual risks

- **`/__zodex/shutdown` is unauthenticated and `process.exit(0)`s** (`server.ts:373-377`). Safe under the default `127.0.0.1` bind and this tool's single-user/local threat model (the bridge already runs Codex with `--dangerously-bypass-approvals-and-sandbox`). Residual risk only if someone sets `ZODEX_HOST` to a non-loopback address — then any host on the network can kill the bridge. Worth a README line; not a merge blocker.
- **Restart → immediate re-spawn could race the port.** `waitForStopped` polls health to zero, then `spawnDetachedServer` rebinds the same port (`cli.ts:270-280`). Relies on `SO_REUSEADDR`/fast socket teardown; your CLI smoke test exercised exactly this path and it worked, so flagging as residual only.
- **Plain `zodex codex` reuses a running debug server unchanged** — `debugConfigMatches` returns `true` when the new invocation isn't debug (`cli.ts:209`). Harmless (extra logging + the server's 120s timeouts apply to that request), but it's a behavioral coupling worth knowing.
- **Pre-existing, not introduced here:** non-stream body stall after headers (`await upstream.json()`, `server.ts:336`) has no timeout; client-disconnect `cancel` only logs and doesn't abort the upstream read (`server.ts:324`). Both acknowledged in round 1.
- **Doc gap:** README documents debug flags well but doesn't mention the restart-on-mismatch behavior or the shutdown route.

## 3. Verification notes

- `bun run typecheck` → clean (`tsc --noEmit`).
- `bun test` → 24 pass / 0 fail, 5 files. Includes the new `tests/cli.test.ts` (leading parse, trailing `serve --debug`, `--zodex-*`-only consumption stopping at first Codex arg) and `tests/debug.test.ts` redaction.
- `bun run build` → compiles `dist/zodex` clean.
- Re-derived the lazy-logging guarantee from `debug.ts:133-136` and confirmed by enumerating call sites that every heavy payload is behind a thunk and every non-lazy call is cheap or error/once-only.
- Confirmed `debugConfigMatches` ↔ `/health` field symmetry (`cli.ts:212-218` vs `server.ts:360-370`): `debug.enabled/trace/file` + both timeouts line up, including the `?? null` file normalization.
- Re-examined the round-1 SSE idle-timeout race (`responses.ts:641-657`): the losing `reader.read()` keeps `Promise.race`'s internal reaction attached, so a late rejection is not unhandled; `cancel()` settles it as `{done:true}`. Safe.
- Did not run a live upstream call (no network); relied on the author's wrapper smoke test for end-to-end log content.

## 4. Verdict

VERDICT: GO
