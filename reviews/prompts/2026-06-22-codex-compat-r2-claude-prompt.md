# Claude Review Prompt: zodex Codex compatibility fixes r2

Repo under review: `/home/pierre/Tools/codex-bridge/zodex`
Reference Codex source: `/home/pierre/Tools/codex-bridge/codex`

User intent:
- Review the fixes applied after your first `VERDICT: FIXES_REQUIRED`.
- Verify that the current zodex implementation is compatible with the local Codex Responses source for namespace tools, reasoning items, and stream/error handling.
- Do not edit files.

First review artifact:
- `/home/pierre/Tools/codex-bridge/zodex/reviews/2026-06-22-codex-compat-claude-review.md`

Scope for this r2 review:
- `src/tool-names.ts`
- `src/translate.ts`
- `src/responses.ts`
- `src/server.ts`
- `tests/translate.test.ts`
- `tests/responses.test.ts`
- `README.md` tool handling notes

Important context:
- The worktree also contains earlier debug/cancellation changes in `src/cli.ts`, `src/debug.ts`, `src/types.ts`, `src/upstream.ts`, `tests/cli.test.ts`, and `tests/debug.test.ts`.
- Please focus this r2 review on the compatibility fixes made in response to your first findings.

Applied fixes:
1. Namespace tools:
   - Added `src/tool-names.ts`, a deterministic codec built from `request.tools`.
   - Responses namespace tools are flattened into sanitized unique Chat Completions function names.
   - Prior `function_call` history with `{ namespace, name }` is encoded to the same chat name.
   - Streaming and non-streaming Chat Completion tool calls are decoded back into Codex `{ namespace, name }` fields before `function_call` items are emitted.
   - `server.ts` now emits a `tools.dropped` debug event for unsupported Responses-only tool types.

2. Reasoning items:
   - Streaming and non-streaming reasoning items now include `encrypted_content: null`.
   - Streaming reasoning now uses summary-style events:
     - `response.reasoning_summary_part.added`
     - `response.reasoning_summary_text.delta`
     - `response.reasoning_summary_text.done`
   - Reasoning input items are dropped when translating history into Chat Completions messages, to avoid `[reasoning]` pollution.

3. Error shape:
   - `errorResponse` now emits `error.code` as a string.

4. Streaming tool-call id hardening:
   - Empty upstream ids are ignored.
   - A synthetic id for an index is migrated to a later real id without splitting the tool state.

Validation already run after these fixes:
- `bun run typecheck` => pass.
- `bun test` => pass, 34 tests.
- `bun run build` => pass, generated `dist/zodex`.
- Live smoke:
  - `./dist/zodex codex --zodex-debug=trace --zodex-debug-file /tmp/zodex-codex-compat-debug.log exec --json "Reply exactly OK. Do not run commands or inspect files."`
  - Result: Codex/Z.AI replied `OK`.
  - Debug evidence: Codex request had 19 tools including 4 namespace containers plus `web_search` and `image_generation`; zodex translated to 69 chat function tools and logged only `web_search`/`image_generation` as dropped.
- Live namespace-tool smoke:
  - `./dist/zodex codex --zodex-debug=trace --zodex-debug-file /tmp/zodex-namespace-debug.log exec --json "Use the codegraph_status tool with projectPath /home/pierre/Tools/codex-bridge/codex. Reply with only the indexed file count, as digits."`
  - Result: model called Codex MCP `codegraph_status`; Codex executed it and replied `3129`.
  - Debug evidence: upstream first turn had `tool_calls:1` and `finish_reason:"tool_calls"`; second turn completed normally.

Please review:
- Whether the namespace codec is safe enough for Codex's current namespace and MCP tool shapes.
- Whether reasoning item/event shapes now match current Codex deserialization and event handling.
- Whether any new edge cases or regressions were introduced.
- Whether any first-review finding remains unfixed.

Required output:
- Findings first, ordered by severity, with concrete source references.
- Open questions or residual risks.
- Verification notes.
- End with exactly one final verdict line:
  - `VERDICT: GO`
  - or `VERDICT: FIXES_REQUIRED`
