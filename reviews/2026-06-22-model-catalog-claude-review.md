I have a complete, empirically-grounded picture. Here are my findings.

## Findings

### 1. Catalog contains 6 fields that don't exist in Codex's `ModelInfo` schema (incorrect schema assumption, currently harmless)
I diffed the generated catalog against `codex debug models --bundled` (6 real models, all 30–31 fields). The generated entry includes six fields present in **none** of the real models:

`default_service_tier`, `auto_compact_token_limit`, `comp_hash`, `auto_review_model_override`, `tool_mode`, `multi_agent_version`

I verified what Codex does with them: I generated the real catalog via `glm52ModelCatalogJson(...)` and ran `codex debug models -c 'model_catalog_json=...'`. Codex parses it fine and **silently drops all six** in the round-tripped output (default serde ignores unknown fields). So they are dead weight today, but they are genuinely "incorrect schema assumptions" and would become a hard parse failure if Codex ever enables `deny_unknown_fields`. The generated catalog is **not missing** any real field — every field the real models emit is present. Recommend trimming the six phantom fields.

### 2. `web_search_tool_type: "text"` is inconsistent with `supports_search_tool: false`, and advertises a tool the bridge may not support
Every real Codex model pairs `web_search_tool_type` with `supports_search_tool: true`. The generated entry sets `web_search_tool_type: "text"` (search enabled) but `supports_search_tool: false`. More importantly, this is a text-only model bridged to Z.AI's Responses API — if Codex offers a `web_search` tool based on `web_search_tool_type` and the Z.AI upstream rejects it, tool calls could fail. The validated `codex exec "Reply with exactly: ok"` run never exercises search, so this risk is latent, not disproven. Consider `web_search_tool_type: null` unless web search is confirmed to work through the bridge.

### 3. `context_window: 1_000_000` is the most material correctness risk (unverifiable here)
With `context_window`/`max_context_window` = 1M, `auto_compact_token_limit: null`, and `effective_context_window_percent: 95`, Codex will not auto-compact until ~950K tokens. If GLM-5.2's *real* upstream limit is smaller, long sessions will never compact and will eventually be rejected by Z.AI with a context-length error — a broken session rather than graceful compaction. This depends on GLM-5.2's true spec, which I can't verify. Please confirm 1M against Z.AI's published GLM-5.2 limits. (The `description`'s "128K max output" claim is purely cosmetic — no catalog field encodes max output tokens — so if wrong it only misleads.)

### 4. Missing tests for the base-instructions selection path (the "live prompt material")
The install test passes `codexBaseInstructions` explicitly, which **bypasses** the entire new spawn/parse/select path. `selectBaseInstructions` (preference-list ordering, non-record filtering, first-with-instructions fallback, null return) and the `FALLBACK_CODEX_BASE_INSTRUCTIONS` branch in `codexBaseInstructionsForCatalog` have **zero** coverage. `selectBaseInstructions` is the most logic-heavy new pure function and isn't exported, so it can't be unit-tested as written. I did verify it works end-to-end: the installed `~/.codex/zai-glm52.models.json` carries the exact 12341-char gpt-5.3-codex base instructions from the bundle, so the live path is correct — but it's untested in CI.

### 5. `zaiReasoningEffort` — minor coverage/behavior notes (intended, but worth flagging)
- Behavior change is intentional but silent: any sub-high effort (`minimal`/`low`/`medium`, plus empty/unknown strings) now maps to `"high"`. A user who deliberately picks low effort for speed/cost will silently get `high`. Consistent with the catalog advertising only high/max, but undocumented.
- Tests cover `medium→high`, `xhigh→max`, `max→max`. Untested: the `ultracode` branch (also note `ultracode` isn't a standard Codex reasoning effort — harmless but odd to special-case), case-insensitivity, and the default branch for arbitrary unknown input.

## Open questions / residual risks
- **GLM-5.2 capability flags are advertised but unverified against the upstream:** `supports_reasoning_summaries: true`, `supports_parallel_tool_calls: true`, `web_search_tool_type: "text"`, and `default_reasoning_summary: "auto"`. The one validated run (single short reply) exercises none of these. If Z.AI's GLM-5.2 doesn't return reasoning summaries or doesn't support parallel tool calls, these could cause subtle runtime mismatches.
- **`high` upstream value is not directly validated** — the live run only proved `max` works (`reasoning effort: max`). `high` is the documented Z.AI value but wasn't exercised end-to-end.
- **Reliance on serde's lenient unknown-field handling** ties catalog validity to current Codex deserialization behavior (see finding 1).
- `uninstall` does not remove the new `zai-glm52.models.json` — but it also doesn't remove the profile `.config.toml`, so this is consistent with existing behavior, not a regression.

## Verification notes (independently run)
- `bun test` → **38 pass, 0 fail** (37ms).
- `codex debug models --bundled` → valid JSON, 6 models, top key `models`; runs in **30ms** (the 3s install timeout is very generous).
- Field diff: generated catalog has all real fields + 6 nonexistent ones; missing none.
- Generated the real catalog via `glm52ModelCatalogJson(...)` and validated through `codex debug models -c 'model_catalog_json=...'`: Codex accepts it, emits no warning, surfaces `glm-5.2` with `context_window: 1000000`, `default_reasoning_level: "max"`, supported levels `high`/`max`, and **drops the 6 unknown fields**.
- Installed catalog at `~/.codex/zai-glm52.models.json` contains the exact gpt-5.3-codex bundled `base_instructions` (12341 chars, byte-identical) — confirms the spawn→parse→select path works in the standalone `dist/zodex` build and did **not** fall back.
- `truncation_policy {mode:"tokens",limit:10000}` and `supported_reasoning_levels[*]` shape (`{effort, description}`) match the real schema exactly.

Net: every stated acceptance criterion is validated working — catalog generated, profile references it, the metadata warning is gone, the standalone build pulls real bundled instructions, and reasoning effort resolves to `max`. The findings above are real correctness/cleanliness improvements and risks to confirm (notably the 6 phantom fields and the 1M context-window value), but none breaks the stated intent or current behavior.

VERDICT: GO
