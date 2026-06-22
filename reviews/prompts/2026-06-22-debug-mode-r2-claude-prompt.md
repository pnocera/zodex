Re-review the current zodex diff in /home/pierre/Tools/codex-bridge/zodex after fixes from:

- reviews/2026-06-22-debug-mode-claude-review.md

Fixes applied after the first review:
- Debug logger now accepts lazy payload builders so disabled debug mode returns before expensive summaries/serialization are computed.
- `mkdirSync` for debug log directories is done once at logger creation, not per log line.
- Upstream payload byte logging is lazy.
- Server request summaries, translated payload byte counts, and per-stream chunk summaries are lazy or skipped when debug is disabled.
- `/health` now reports debug state and timeout config.
- New `POST /__zodex/shutdown` lets the CLI restart an existing zodex server to apply requested debug settings.
- `zodex codex --zodex-debug ...` now restarts a compatible existing bridge if its debug config does not match.
- `zodex serve --debug` now works via command-specific option parsing.
- Codex option parsing now only consumes `--zodex-*` flags before the first real Codex argument.
- Added parser tests in `tests/cli.test.ts`.

Validation after fixes:
- `bun run typecheck`
- `bun test`
- `bun run build`
- CLI restart smoke:
  - Started a normal bridge on 127.0.0.1:31452.
  - Ran `./dist/zodex codex --zodex-debug --zodex-debug-file /tmp/zodex-cli-debug.log --zodex-upstream-fetch-timeout-ms=30000 --zodex-stream-idle-timeout-ms=30000 --help`.
  - Confirmed `/health` reported debug enabled with the requested file/timeouts.
- Real wrapper smoke:
  - Ran `./dist/zodex codex --zodex-debug --zodex-debug-file /tmp/zodex-cli-debug.log --zodex-upstream-fetch-timeout-ms=30000 --zodex-stream-idle-timeout-ms=30000 exec --json "Reply exactly OK. Do not run commands or inspect files."`
  - It returned `OK`.
  - `/tmp/zodex-cli-debug.log` recorded request size, translated payload size, upstream timing, chunk counts, and clean close.

Please review for remaining blockers only:
- Did the lazy logging actually remove default-mode heavy work?
- Is the restart route/CLI restart behavior safe enough for this local bridge?
- Any remaining redaction, parser, timeout, or test issue that should block merging?

Do not edit files.

Output format:
1. Findings first, ordered by severity with file/line references.
2. Open questions or residual risks.
3. Verification notes.
4. Final verdict line exactly one of:
   VERDICT: GO
   VERDICT: FIXES_REQUIRED
