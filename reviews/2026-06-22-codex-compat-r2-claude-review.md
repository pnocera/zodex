I've completed a full cross-repo verification against the local Codex source. Tests (34 pass) and typecheck are green on my own run. Here is the r2 review.

---

# zodex ↔ Codex Responses Compatibility Review (r2)

I re-read both sides: zodex `tool-names.ts`, `translate.ts`, `responses.ts`, `server.ts`, and tests, against Codex `protocol/src/models.rs`, `protocol/src/tool_name.rs`, `tools/src/responses_api.rs`, `core/src/tools/router.rs`, `core/src/tools/mod.rs`, `core/src/tools/spec_plan.rs`, and `codex-api/src/sse/responses.rs`. No files were edited.

**Bottom line:** every finding from the first review (F1, F1b, F2, F3, F4, F5, F6, and the input-side reasoning coupling) is fixed and verified against current Codex deserialization. The fixes match Codex's wire contract exactly. No regressions found. Only low-severity, already-acknowledged residual risks remain.

## Verification of each prior finding

### F1 + F1b — Namespace tools (HIGH) → FIXED & verified
- `normalizeTools` now flattens `type:"namespace"` containers into sanitized unique chat function names (`translate.ts:193-212`), and plain functions through the same codec (`:219-220`).
- **The decode round-trip is provably correct.** zodex builds the codec from `request.tools` and decodes the flat name back to the *exact* `{namespace, name}` strings Codex advertised. Codex reconstructs the call via `ToolName::new(namespace, name)` (`router.rs:115-128`), and `ToolName::new` is a no-transform struct literal (`tool_name.rs:14-20`). Critically, the registry keys namespaced tools as `ToolName::namespaced(namespace, inner_name)` while advertising `ResponsesApiNamespace { name: namespace, tools:[Function{name: inner_name}]}` (`spec_plan.rs:1044-1054`) — so advertised `(NS, INNER)` ⇒ dispatch `ToolName{namespace:Some(NS), name:INNER}`. zodex's decode reproduces `(NS, INNER)` byte-for-byte. Exact match. ✓
- **F1b:** `functionCallFromItem` now reads `item.namespace` and re-encodes history through the codec (`translate.ts:80-87`), so replayed namespaced calls keep a name consistent with the advertised tool. The test at `translate.test.ts:105-140` locks this (`mcp.fs`/`read/file` → `mcp_fs_read_file`, and history encodes to the *same* name).
- Codec is a pure function of `request.tools`, rebuilt identically in `translateResponsesRequest`, `ResponsesStreamTranslator` ctor, and `chatCompletionToResponse` — deterministic, no shared state. Collision/suffix handling (`uniqueToolName`, `tool-names.ts:50-66`) is covered by `translate.test.ts:142-163` and stays ≤64 chars.

### F2 — Reasoning `encrypted_content` (HIGH) → FIXED & verified
- `Reasoning` declares `summary: Vec<…>` and `encrypted_content: Option<String>` with **no `#[serde(default)]`** (`models.rs:951,955`) — both are required keys. zodex now emits `encrypted_content: null` and a `summary` array on **all three** emit sites: non-stream `reasoningItem` (`responses.ts:22-30`), stream `output_item.added` (`responses.ts:494-501`), and stream `output_item.done` (`responses.ts:344`). All deserialize cleanly into `ResponseItem::Reasoning`. The extra `status` field on the added event is ignored (the enum is internally tagged, no `deny_unknown_fields`). ✓
- `summary_text` shape matches `ReasoningItemReasoningSummary::SummaryText{text}` under `rename_all="snake_case"` (`models.rs:1596-1600`). ✓
- Guarded by `responses.test.ts:251-275` and `:360-375`.

### F3 — Error `code` string (MEDIUM) → FIXED & verified
- `errorResponse` now emits `code: String(status)` (`responses.ts:164-178`). Codex's `Error.code` is `Option<String>` (`sse/responses.rs:95`); a numeric value previously failed the whole-struct deserialize at `:357` and discarded the message. With a string, deserialization succeeds and the real upstream message survives into `ApiError::Retryable{message,…}` (`:376-378`). Test `responses.test.ts:378-385`. ✓

### F4 — Streaming tool-id hardening (LOW–MED) → FIXED & verified
- Empty-string ids are now ignored (`responses.ts:527`), preventing all calls collapsing into one.
- Synthetic→real id migration renames the `ToolState` and `toolsById`/index maps in place (`:530-546`) — no split. Test `responses.test.ts:198-249`.
- **Stronger than required:** I confirmed Codex's `process_responses_event` has **no handler** for `response.function_call_arguments.delta` / `function_call_name.done` (the only reference is a test fixture, `sse/responses.rs:834`). Codex relies entirely on the final `response.output_item.done` `function_call` item for name/namespace/call_id/arguments. So even the pre-migration arg-delta with the synthetic id, and the `output_item.added` with the synthetic id, are harmless — the authoritative done-item carries the real `call_id` and full args. ✓

### F5 — Reasoning streaming events (LOW) → FIXED & verified
- Switched to the summary-style stream: `reasoning_summary_part.added` + `reasoning_summary_text.delta` (+ `…text.done`), all with `summary_index: 0` (`responses.ts:503-520, 337-343`). This matches the only delta path Codex accepts — `reasoning_summary_text.delta` requires `(delta, summary_index)` (`sse/responses.rs:332-338`) and `reasoning_summary_part.added` requires `summary_index` (`:425-431`). The canonical order (added → part.added → delta* → done → item.done) is emitted correctly. `reasoning_summary_text.done` is unhandled by Codex (falls to the `_ => trace!` arm) — harmless. The choice is consistent with storing reasoning under `summary` in the final item (no summary/content mixing). ✓

### F6 + input-side reasoning (defer/minor) → FIXED & verified
- `server.ts:182-188` emits a `tools.dropped` debug event built from `codec.dropped`, and the codec records each unsupported type with a reason (`tool-names.ts:113-117`). README documents the dropped types and the limitation (`README.md:224-238`). ✓
- `itemToMessages` now drops `reasoning` input items (`translate.ts:135-137`), so the F2 fix won't pollute chat history with `[reasoning]` blocks. Test `translate.test.ts:165-177`. ✓

## Residual risks (all LOW — none block GO)

- **R1 — HTTP status codes map to `Retryable`.** `"400"/"500"/"502"` match none of Codex's known codes, so every upstream failure lands in `ApiError::Retryable{message, delay:None}` (`sse/responses.rs:375-378`). 5xx retrying is fine; 4xx will be retried pointlessly before failing. The message is preserved either way. This is the explicitly-accepted tradeoff from F3. Optional future polish: map 4xx → `invalid_prompt` for a non-retryable shape.
- **R2 — `content_filter` → 400 → Retryable.** A content-filtered stop (`responses.ts:305-310`) surfaces as a retryable error, so Codex may retry it. Cosmetic; not introduced by these fixes.
- **R3 — `tool_choice` forcing a *namespaced* tool by name only.** If a forced `tool_choice` omits `namespace`, `encode` falls back to `sanitizeToolName(name)` without the namespace prefix (`translate.ts:243-249`). Extreme edge case; normal `auto`/`required`/`none` and namespaced-with-field cases are correct.
- **R4 — history `function_call` for a tool dropped from the current `request.tools`.** `encode` falls back to bare `sanitize(name)`; harmless because Chat Completions pairs tool outputs by `tool_call_id`, not name.

## Open questions
- Confirm whether GLM/Z.AI ever streams a tool call with `id` only in a *later* chunk than `arguments` for the same index (the exact ordering F4 hardens against). The migration makes it safe regardless, and since Codex ignores arg-deltas, even an imperfect split is inert — so this is informational only.

## Verification notes
- `bun test` → **34 pass / 0 fail** (independently re-run).
- `bun run typecheck` (`tsc --noEmit`) → **pass**.
- Namespace round-trip, decode (stream + non-stream), reasoning envelope shape, tool-id migration, and string error-code are each covered by dedicated tests.
- Codex-side claims verified by reading source, not inference: `ToolName::new` (no transform), namespace registry/spec correspondence (`spec_plan.rs:1044-1054`), `Reasoning`/`FunctionCall` required-field semantics (`models.rs:947-989`), SSE reasoning/error/item handling (`sse/responses.rs:304-438`), and the absence of any `function_call_arguments.delta` consumer.
- Not executed (would require a live reasoning-model run): an end-to-end Codex turn that records a reasoning item and replays it next turn. The deserialization is now structurally satisfied, so the prior silent-drop is resolved; a live reasoning-model smoke would make it incontrovertible.

VERDICT: GO
