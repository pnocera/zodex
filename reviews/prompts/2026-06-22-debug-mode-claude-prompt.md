Review the current zodex diff in /home/pierre/Tools/codex-bridge/zodex.

Scope:
- Debug mode and observability for the Z.AI/Codex bridge.
- New structured debug logger in src/debug.ts.
- Runtime config knobs in src/upstream.ts and src/types.ts.
- Upstream fetch timeout diagnostics.
- SSE idle timeout diagnostics in src/responses.ts.
- Request/stream instrumentation in src/server.ts.
- CLI flags for zodex debug mode in src/cli.ts.
- README and tests.

User intent:
- We need useful bridge-level evidence when Codex via Z.AI goes quiet or hangs.
- Debug mode must work when zodex is auto-started detached by `zodex codex`.
- Do not expose ZAI_API_KEY or authorization secrets in logs.
- Keep normal operation lightweight and avoid changing non-debug behavior except for explicit env/flag config.
- Keep the standalone `dist/zodex` build working.

Validation already run:
- `bun run typecheck`
- `bun test`
- `bun run build`
- Live non-streaming GLM request through debug server on port 31453 returned OK.
- Live streaming GLM request through debug server on port 31453 completed.
- Fake upstream that never returned headers produced a quick Responses `response.failed` with `upstream fetch exceeded 50ms` and useful log events.
- Fake upstream that sent one SSE event and stalled produced `response.stream.error` with `upstream SSE idle timeout after 50ms`.

Please review for:
- Bugs or race conditions in timeout/cancellation handling.
- Log redaction gaps or over-redaction.
- CLI flag parsing mistakes, especially accidental consumption of Codex args.
- Debug-mode behavior when server is detached.
- Test gaps that should block merging.

Do not edit files.

Output format:
1. Findings first, ordered by severity with file/line references.
2. Open questions or residual risks.
3. Verification notes.
4. Final verdict line exactly one of:
   VERDICT: GO
   VERDICT: FIXES_REQUIRED
