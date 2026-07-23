# Review request: zodex

## Repo
`/home/pierre/Tools/zodex` — review the current working tree (all committed).

## What this is
`zodex` is a small **Bun + TypeScript** local bridge that lets the **Codex CLI** drive
models that only expose an **OpenAI Chat Completions** API. Codex speaks the OpenAI
**Responses** API to custom providers; zodex runs a local HTTP server that accepts
Responses-API requests, translates them to Chat Completions for an upstream
(Z.AI GLM, and — via config — Synthetic's OpenAI-compatible endpoint), and translates
the (streaming) Chat Completions response back into Responses-API events. It also has an
installer that writes a Codex profile + model catalog and zsh aliases.

Read the code and discover the behaviour yourself — do not trust this description over the
source. Source layout to orient (read what you need):

- `src/server.ts` — HTTP server, routes (`/responses`, `/v1/responses`, `/health`, `/models`,
  shutdown), request handling, SSE plumbing.
- `src/translate.ts` — Responses request → Chat Completions request; tool-name codec.
- `src/responses.ts` — Chat Completions (incl. streaming deltas) → Responses events/objects.
- `src/upstream.ts` — upstream fetch, auth, retries, timeouts, abort relay, runtime config from env.
- `src/tool-names.ts`, `src/ids.ts`, `src/debug.ts`, `src/constants.ts`, `src/types.ts` — helpers/types.
- `src/cli.ts` — command dispatch + bridge lifecycle (health check, detached spawn, restart, shutdown).
- `src/install.ts` — writes `~/.codex/<profile>.config.toml`, the model catalog JSON, and a managed
  zsh alias block; seeds Codex folder-trust.
- `index.ts` — entrypoint. `tests/` — the existing test suite.

## Scope & intent
General correctness/robustness review of the whole (small) codebase, with weight on:
- the **translation layer** — request and streaming-response fidelity, tool/function-call
  round-tripping (ids and names), reasoning content, function-call outputs, and edge cases
  (empty deltas, partial chunks, missing fields, multiple/parallel tool calls);
- **upstream** handling — auth, retry/backoff, abort propagation, timeouts, error passthrough;
- **cli/bridge lifecycle** — health/detached-spawn/restart/shutdown races, stale-server reuse;
- **install** — safety of mutating the user's `config.toml` and `.zshrc` (atomicity, idempotency,
  concurrent runs, TOML/marker-block correctness, backup, trust seeding).

## Validation already run (green)
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun test` — 40 pass / 0 fail across 5 files.

## What I'd like from the review
- Verify assumptions **against the actual source**, not this prose — especially the
  Responses↔Chat-Completions shapes, SSE event framing/ordering, and tool call id/name mapping.
- **Audit the tests for false-green holes** — assertions that would still pass if the behaviour
  regressed (over-narrow snapshots, fixtures that mask a bug, substring asserts, untested stream
  paths). This is as valuable as the source check.
- Flag concurrency/lifecycle hazards in the bridge and in `install.ts`'s file mutations.
- Give **every** finding — BLOCKER, WARN, and NIT — a concrete, actionable recommended fix; they
  will all be considered, not just blockers.

## Output
Structured findings grouped by severity (BLOCKER / WARN / NIT), each with file:line and a
concrete fix. End with a final line that is exactly `VERDICT: GO` or `VERDICT: FIXES_REQUIRED`.
