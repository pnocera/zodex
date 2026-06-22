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
- Filters Responses-only tool containers before forwarding to Z.AI.
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

## Codex Profile And Aliases

```bash
bun run build
./dist/zodex install
```

This writes `~/.codex/zai-glm52.config.toml` and updates a managed block in
`~/.zshrc`. It does not rewrite `~/.codex/config.toml` and never writes
`ZAI_API_KEY`.

Generated profile:

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

Codex may send Responses-only tool containers such as `type: "namespace"`.
Z.AI Chat Completions rejects those tool entries. `zodex` forwards only
Chat-Completions-compatible function tools and drops unsupported tool container
metadata.

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

The test suite covers request translation, unsupported tool filtering, streaming
event assembly, repeated deltas, usage normalization, install helpers, uninstall
block removal, and 429 retry delay behavior.

## Configuration

Environment variables:

- `ZAI_API_KEY`: required upstream API key.
- `ZODEX_HOST`: listen host, default `127.0.0.1`.
- `ZODEX_PORT`: listen port, default `31452`.
- `ZODEX_MODEL`: default model, default `glm-5.2`.
- `ZODEX_UPSTREAM_BASE_URL` or `ZAI_BASE_URL`: upstream base URL override.
- `ZODEX_DEBUG=1`: print bridge diagnostics to stderr.

## Review Artifacts

Claude review artifacts are stored under `reviews/`:

- `reviews/2026-06-22-design-claude-review.md`
- `reviews/2026-06-22-implementation-claude-review.md`
- `reviews/2026-06-22-implementation-r2-claude-review.md`
