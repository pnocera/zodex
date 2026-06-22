# zodex design

`zodex` is a small Bun gateway that lets Codex talk to Z.AI GLM models through the OpenAI Responses API shape that recent Codex releases expect.

## Goal

- Expose `POST /responses` and `POST /v1/responses` locally.
- Translate OpenAI Responses requests from Codex to Z.AI Chat Completions requests.
- Translate Z.AI streaming Chat Completions chunks back to Responses server-sent events.
- Preserve the parts Codex relies on most: output text, reasoning text, function calls, function-call arguments, tool outputs, and terminal response events.
- Install a user-level Codex profile for `glm-5.2` without rewriting the main Codex config.
- Add shell aliases:
  - `cx='codex --dangerously-bypass-approvals-and-sandbox'`
  - `cxz='codex --profile zai-glm52 --dangerously-bypass-approvals-and-sandbox'`

## Non-goals

- Do not vendor LiteLLM or run a full proxy/router stack.
- Do not auto-update from npm or the network.
- Do not rewrite `~/.codex/config.toml`.
- Do not store `ZAI_API_KEY` in any file.
- Do not support the full OpenAI API surface beyond what Codex needs.

## Runtime

- Bun-only TypeScript, no production dependencies.
- Standalone executable build via `bun build --compile`.
- Default listen address: `127.0.0.1`.
- Default port: `31452`.
- Upstream base URL: `https://api.z.ai/api/coding/paas/v4`.
- API key source: `ZAI_API_KEY`.
- Default model: `glm-5.2`.

## Request Translation

The translator should borrow the stronger ideas from `codex-zai-proxy`:

- Merge `instructions`, `system`, and `developer` content into a single leading `system` message for Z.AI.
- Preserve prior assistant/function-call context where possible:
  - `message`
  - `function_call`
  - `function_call_output`
  - `local_shell_call`
  - `custom_tool_call`
  - `custom_tool_call_output`
  - `tool_search_call`
  - `reasoning`
- Map `max_output_tokens` to Z.AI `max_tokens`.
- Pass `temperature`, `top_p`, `tool_choice`, `parallel_tool_calls`, and normalized function tools when present.

## Streaming Translation

The stream should borrow the richer event shape from `zai-codex-bridge`:

- Emit `response.created`.
- Emit `response.in_progress`.
- Emit `response.output_item.added` before text or tool output.
- Emit `response.content_part.added` / `response.content_part.done` around text.
- Emit `response.output_text.delta` and `response.output_text.done`.
- Emit `response.reasoning_text.delta` and `response.reasoning_text.done` when upstream reasoning appears.
- Emit `response.function_call_name.done`, `response.function_call_arguments.delta`, and `response.function_call_arguments.done` for tool calls.
- Emit `response.output_item.done` for completed text and tool-call items.
- Emit `response.completed` with a populated `output` array.
- Emit `response.failed` for upstream errors.
- Include monotonic `sequence_number` fields on events.

## Install Command

`bun run zodex install` should:

- Create `~/.codex/zai-glm52.config.toml`.
- Leave `~/.codex/config.toml` untouched.
- Add or update a marked block in `~/.zshrc` for `cx` and `cxz`.
- Prefer `dist/zodex` in the `cxz` alias when a standalone build exists.
- Avoid duplicate alias blocks on repeated runs.
- Never write secrets.

Current Codex profile loading is based on a sibling profile file selected with
`--profile profile-name`. The profile file uses top-level keys, not legacy
`[profiles.profile-name]` tables inside `~/.codex/config.toml`.

The generated profile should be:

```toml
model = "glm-5.2"
model_provider = "zodex-zai"

[model_providers.zodex-zai]
name = "Z.AI GLM 5.2 via zodex"
base_url = "http://127.0.0.1:31452"
env_key = "ZAI_API_KEY"
wire_api = "responses"
stream_idle_timeout_ms = 3000000
```

The aliases intentionally disable approvals and sandboxing because the user
requested that behavior:

```zsh
alias cx='codex --dangerously-bypass-approvals-and-sandbox'
alias cxz='/home/pierre/Tools/codex-bridge/zodex/dist/zodex codex'
```

`cxz` may point at `bin/zodex` before a standalone build exists. `zodex codex`
starts the local bridge if needed, then execs Codex with the `zai-glm52`
profile and the dangerous bypass flag.

`ZAI_API_KEY` must be exported in the live shell. The installer never writes it.

## Robustness

- Lowercase model names before forwarding upstream.
- Fail fast with a clear message when `ZAI_API_KEY` is not set.
- Repair simple malformed function-call JSON arguments when braces or brackets are unbalanced.
- Treat cumulative content/tool-argument chunks as cumulative and emit only the new delta.
- Convert upstream non-200 responses and `finish_reason: content_filter` to `response.failed`.
- Keep the bridge bound to `127.0.0.1` by default.

## Verification

Minimum local checks:

- `bun run typecheck`
- `bun test`
- Direct smoke against the local server for:
  - non-streaming text response
  - streaming text response
  - streaming function call
  - `/v1/models`
- Manual Codex smoke with `cxz` after install.
