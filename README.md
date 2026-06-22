# zodex

`zodex` is a small Bun bridge that lets Codex use Z.AI GLM 5.2 through a local
OpenAI Responses-compatible endpoint.

It exists because Codex currently expects the OpenAI Responses API for custom
providers, while Z.AI exposes GLM through an OpenAI-compatible Chat Completions
API. `zodex` translates between those two shapes without running a broad router
such as LiteLLM.

## Features

- Local `POST /responses` and `POST /v1/responses` endpoints for Codex.
- Translates Responses input into Z.AI Chat Completions messages.
- Streams Chat Completions chunks back as Responses SSE events.
- Supports text, reasoning, tool calls, function call outputs, and normalized
  Responses usage.
- Flattens Codex namespace tools into reversible Chat Completions function names
  and decodes them back before returning tool calls to Codex.
- Logs unsupported Responses-only tool types before filtering them from the Z.AI
  request.
- Emits structured debug logs with request ids, upstream timing, stream chunk
  counts, idle timeouts, and redacted credentials.
- Builds a standalone executable with `bun build --compile`.
- Installs a Codex profile and zsh aliases without rewriting
  `~/.codex/config.toml`.

## Requirements

- Bun 1.3 or newer for development and building.
- Codex CLI with profile-file support.
- A Z.AI API key exported as `ZAI_API_KEY`.

## Quick Start

```bash
bun install
bun run typecheck
bun test
bun run build
./dist/zodex install
```

Open a new shell, or reload zsh:

```bash
source ~/.zshrc
```

Then run Codex with GLM 5.2:

```bash
cxz
```

For non-interactive smoke testing:

```bash
cxz exec "Reply exactly OK. Do not run commands or inspect files."
```

For bridge diagnostics on an existing `cxz` alias:

```bash
ZODEX_DEBUG=1 cxz exec "Reply exactly OK."
tail -f ~/.zodex/debug.log
```

## Run The Bridge Manually

```bash
bun run serve
# or
./dist/zodex serve
```

Defaults:

- Listen: `127.0.0.1:31452`
- Upstream: `https://api.z.ai/api/coding/paas/v4`
- Model: `glm-5.2`
- API key: `ZAI_API_KEY`

Endpoints:

- `GET /health`
- `GET /v1/models`
- `POST /responses`
- `POST /v1/responses`

## Standalone Executable

```bash
bun run build
./dist/zodex serve
```

The compiled binary is self-contained and can also launch Codex:

```bash
./dist/zodex codex
```

The compiled binary is generated at `dist/zodex`. The `dist/` directory is
ignored by git; rebuild locally when needed.

## Debug Mode

Debug mode is meant for diagnosing quiet streams, upstream stalls, malformed
chunks, retries, and translation issues without exposing prompts or credentials.
Logs are JSON Lines and redact API keys, authorization headers, tokens,
passwords, and secrets.

Enable debug mode with environment variables:

```bash
ZODEX_DEBUG=1 cxz exec "Reply exactly OK."
ZODEX_DEBUG=trace cxz exec --json "Reply exactly OK."
```

Or with zodex flags:

```bash
./dist/zodex --debug serve
./dist/zodex --debug=trace serve
./dist/zodex codex --zodex-debug exec "Reply exactly OK."
./dist/zodex codex --zodex-debug=trace exec --json "Reply exactly OK."
```

When debug is enabled, zodex writes to `~/.zodex/debug.log` by default. This
matters because `zodex codex ...` starts the bridge detached when it is not
already running, and detached server stderr is not visible. Override the log path
with:

```bash
ZODEX_DEBUG_FILE=/tmp/zodex-debug.log ZODEX_DEBUG=1 cxz exec "Reply exactly OK."
./dist/zodex --debug --debug-file /tmp/zodex-debug.log serve
./dist/zodex codex --zodex-debug --zodex-debug-file /tmp/zodex-debug.log exec "Reply exactly OK."
```

Debug mode also enables explicit upstream timeouts so hangs turn into useful
Responses errors:

- `ZODEX_UPSTREAM_FETCH_TIMEOUT_MS`: timeout while waiting for upstream response
  headers. Default in debug mode: `120000`; default outside debug mode: off.
- `ZODEX_STREAM_IDLE_TIMEOUT_MS`: timeout while waiting for the next upstream
  SSE chunk after streaming starts. Default in debug mode: `120000`; default
  outside debug mode: off.

Examples:

```bash
ZODEX_DEBUG=1 ZODEX_UPSTREAM_FETCH_TIMEOUT_MS=30000 cxz exec "Reply exactly OK."
./dist/zodex codex --zodex-debug --zodex-stream-idle-timeout-ms=30000 exec "Reply exactly OK."
```

Useful log events include:

- `request.received`, `request.parsed`, `request.translated`
- `upstream.fetch.start`, `upstream.fetch.response`, `upstream.fetch.retry`,
  `upstream.fetch.error`
- `response.stream.start`, `response.stream.upstream_chunk`,
  `response.stream.finish`, `response.stream.error`, `response.stream.close`
- `upstream.sse.raw_chunk` in `trace` mode

When `zodex codex --zodex-debug ...` finds an already-running zodex bridge with
different debug settings, it asks that local bridge to stop and then starts a new
one with the requested settings. The shutdown route is intended for the local
CLI-managed bridge; keep `ZODEX_HOST` on the default loopback address unless you
are deliberately exposing the bridge on a trusted network. A plain `zodex codex`
run reuses any already-running bridge, including a debug-enabled one.

## Codex Profile And Aliases

```bash
bun run build
./dist/zodex install
```

This writes `~/.codex/zai-glm52.config.toml`, writes a single-model
`~/.codex/zai-glm52.models.json` catalog, and updates a managed block in
`~/.zshrc`. It does not rewrite `~/.codex/config.toml` and never writes
`ZAI_API_KEY`.

Generated profile:

```toml
model = "glm-5.2"
model_reasoning_effort = "max"
model_provider = "zodex-zai"
model_catalog_json = "/home/pierre/.codex/zai-glm52.models.json"

[model_providers.zodex-zai]
name = "Z.AI GLM 5.2 via zodex"
base_url = "http://127.0.0.1:31452"
env_key = "ZAI_API_KEY"
wire_api = "responses"
stream_idle_timeout_ms = 3000000
```

The generated model catalog advertises GLM-5.2 as a text-only, reasoning-capable
model with 1M context, 128K maximum output, and `high`/`max` reasoning efforts.
During install, zodex asks the installed Codex binary for its bundled catalog
with `codex debug models --bundled` and reuses Codex's current base instructions
for the GLM entry. If that command is unavailable, zodex falls back to a compact
Codex-compatible base instruction so install remains offline-tolerant.

Aliases:

```zsh
alias cx='codex --dangerously-bypass-approvals-and-sandbox'
alias cxz='/home/pierre/Tools/codex-bridge/zodex/dist/zodex codex'
```

Both aliases intentionally use `--dangerously-bypass-approvals-and-sandbox`.
Use them only in trusted directories.

`cxz` starts the bridge if needed, then launches Codex with:

```bash
codex --profile zai-glm52 --dangerously-bypass-approvals-and-sandbox
```

The installer never writes `ZAI_API_KEY`; export it in the shell before use.

To remove only the managed zsh alias block:

```bash
./dist/zodex uninstall
```

The profile file is left in place for manual removal.

## Tool Handling

Codex may send namespace tools, for example MCP tools grouped under
`type: "namespace"`. Z.AI Chat Completions only accepts function tools, so
`zodex` flattens namespace tools into sanitized unique function names for the
upstream request. When Z.AI returns a tool call, `zodex` decodes the name back
into Codex's separate `namespace` and `name` fields.

Other Responses-only tools such as `web_search`, `web_search_preview`,
`image_generation`, and freeform/custom tool payloads are not native Z.AI Chat
Completions tools. `zodex` drops those tool entries and records a `tools.dropped`
debug event when debug mode is enabled.

Optional Z.AI MCP servers, such as search, reader, zread, and vision, should be
installed as Codex MCP servers rather than embedded inside the bridge payload.

## Verification

Current verification used during development:

```bash
bun run typecheck
bun test
bun run build
cxz exec --json "Reply exactly OK. Do not run commands or inspect files."
cxz exec --json "Run the shell command printf OK, then reply exactly with its output."
```

The test suite covers request translation, namespace tool round trips,
unsupported tool filtering, streaming event assembly, repeated deltas,
late-arriving tool ids, reasoning envelopes, usage normalization, install
helpers, uninstall block removal, and 429 retry delay behavior.

## Configuration

Environment variables:

- `ZAI_API_KEY`: required upstream API key.
- `ZODEX_HOST`: listen host, default `127.0.0.1`.
- `ZODEX_PORT`: listen port, default `31452`.
- `ZODEX_MODEL`: default model, default `glm-5.2`.
- `ZODEX_UPSTREAM_BASE_URL` or `ZAI_BASE_URL`: upstream base URL override.
- `ZODEX_DEBUG=1` or `ZODEX_DEBUG=trace`: enable structured bridge diagnostics.
- `ZODEX_DEBUG_FILE`: debug log path, default `~/.zodex/debug.log` when debug is
  enabled.
- `ZODEX_UPSTREAM_FETCH_TIMEOUT_MS`: upstream response-header timeout.
- `ZODEX_STREAM_IDLE_TIMEOUT_MS`: upstream SSE idle timeout.

## Review Artifacts

Claude review artifacts are stored under `reviews/`:

- `reviews/2026-06-22-design-claude-review.md`
- `reviews/2026-06-22-implementation-claude-review.md`
- `reviews/2026-06-22-implementation-r2-claude-review.md`
