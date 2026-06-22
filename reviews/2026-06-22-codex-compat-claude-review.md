I've completed the cross-repo review. I read both sides: zodex's `translate.ts`, `responses.ts`, `types.ts`, `server.ts`, `upstream.ts` and tests, against Codex's `codex-api/src/sse/responses.rs`, `protocol/src/models.rs`, `tools/src/responses_api.rs`, `core/src/tools/router.rs`, and `core/src/tools/mod.rs`. No files were edited.

Two of the most impactful findings are **not** in your candidate list, and one candidate assumption (#3) is wrong. Details below.

---

# zodex ↔ Codex Responses Compatibility Review

## Findings (by severity)

### F1 — HIGH: Namespace tools are silently dropped (your candidate #1, confirmed)
`normalizeTools` keeps only `tool.type === "function"`:

- `src/translate.ts:156` — `if (tool.type !== "function") { return []; }`

Codex emits namespace tools as `{ type: "namespace", name, description, tools: [{ type: "function", name, description, parameters }] }` (serde tags in `codex-rs/tools/src/responses_api.rs:40-67`), and the debug log confirmed 4 such tools. All are dropped, so MCP / multi-agent / namespaced tools are uncallable through Z.AI.

Your proposed fix (reversible codec built from `request.tools`, flatten inner functions, decode on the way back) is the right shape. Two clarifications:

- **The `flat_tool_name` concern is a red herring.** Codex's `flat_tool_name` (`codex-rs/core/src/tools/mod.rs:39-49`) concatenates `namespace + name` with **no separator** — it is irreversible and is only used for legacy hook/telemetry boundaries, **not** the wire round-trip. On the Responses API, namespace handling is first-party: the model returns a `FunctionCall` with **separate** `namespace` and `name` fields (`models.rs:973-989`), and `ToolRouter::build_tool_call` does `ToolName::new(namespace, name)` (`router.rs:115-128`). So zodex must NOT mimic the concatenation — it must use its **own** reversible codec and, critically, **decode the flat chat name back into separate `{ namespace, name }`** when emitting the final `function_call` item. If zodex flattened but emitted `name: "foo__bar"` with no `namespace`, Codex's `ToolName::new(None, "foo__bar")` would fail dispatch ("unknown tool").
- **F1b (sub-issue, must ship with F1):** `functionCallFromItem` (`src/translate.ts:73-83`) ignores `item.namespace`. When Codex replays a prior namespaced `function_call` in `input`, zodex would emit a chat `tool_call` named `bar` while the tool was advertised as `foo__bar` — a name mismatch in history. The same codec must encode `{namespace,name}` → flat chat name here.

The codec can be a pure function of `request.tools`, derivable identically in `translateResponsesRequest`, `ResponsesStreamTranslator`, and `chatCompletionToResponse` (all already receive `request`/`body`), so no shared mutable state is needed.

### F2 — HIGH: Reasoning items are rejected by Codex (missing `encrypted_content`) — NOT in your list
zodex emits reasoning items without `encrypted_content`:

- `src/responses.ts:313-317` (stream `finish`), `src/responses.ts:468-476` (`output_item.added`), `src/responses.ts:95-99` (non-stream).

Codex's `ResponseItem::Reasoning` (`models.rs:947-958`) declares:
```rust
encrypted_content: Option<String>,   // no #[serde(default)]
```
In serde, `Option<T>` **without** `#[serde(default)]` is a **required key** (it may be `null`, but must be present). `ResponseItem` uses a plain `#[derive(Deserialize)]` (verified: no custom impl; the only custom `Deserialize` is `FunctionCallOutputPayload` at `models.rs:1870`). So `serde_json::from_value::<ResponseItem>` fails, and `process_responses_event` silently drops it:

- `responses.rs:308-315` — `if let Ok(item) … else debug!("failed to parse ResponseItem from output_item.done")` → falls through to `Ok(None)`.

Corroboration: Codex's own fixture `ev_reasoning_item_done` **always** includes `encrypted_content` (`core/tests/common/responses.rs:721-728`), while `ev_reasoning_item_added` omits it — an asymmetry that only makes sense if the `.done` path requires it. No test deserializes a reasoning item lacking it.

**Consequence:** This **invalidates your candidate #3's premise.** You assumed "`output_item.done` carries a reasoning summary, so reasoning is not completely lost." It *is* completely lost: the deltas are dropped (F5) **and** the final item is rejected. Your text smoke test ("OK") wouldn't catch this — reasoning loss is silent.

**Fix:** add `encrypted_content: null` to every emitted reasoning item (`summary` and `{type:"summary_text"}` are already correct per `models.rs:1598-1600`). Minimal and safe.

### F3 — MEDIUM: `response.failed` error `code` is numeric, breaking error propagation — NOT in your list
- `src/responses.ts:147-151` — `error: { type: "upstream_error", code: status, message }` where `status` is the HTTP status **number** (from `server.ts:230,239` and `responses.ts:408`).

Codex's `Error` struct (`responses.rs:91-99`) is `code: Option<String>`. A JSON number cannot deserialize into `Option<String>`, so `serde_json::from_value::<Error>` fails for the whole struct (`responses.rs:356-357`), and Codex falls back to the generic `ApiError::Stream("response.failed event received")` (`responses.rs:355,381-386`). **The real upstream message and any error classification are discarded** — every upstream failure shows up as one opaque string.

**Fix:** emit `code` as a string (e.g. `String(status)` or a mapped code), keeping the numeric status elsewhere if you want it. Note a secondary design choice: a *string* `code` that matches none of Codex's known codes lands in the `Retryable { message, delay }` branch (`responses.rs:375-379`), i.e. Codex would **retry**. That's good for 5xx but pointless for 4xx — consider mapping 4xx to a non-retryable shape (or accept retry-then-fail). Either way, fixing the type restores the message.

### F4 — LOW–MEDIUM (defensive): streaming tool-call id split on late id (your candidate #2, confirmed)
- `src/responses.ts:492` — `const id = delta.id ?? this.toolIdByIndex.get(index) ?? \`call_${index}\``.

If the first chunk for an index has no `id` (→ synthetic `call_0`) and a later chunk supplies a real `id`, the real id wins, `toolsById.get(realId)` misses, and a **second** ToolState is created with an empty name — splitting one call into two (name/args on one, args on the other). Standard OpenAI-compatible streaming sends `id`+`name` in the first delta and only `arguments` after, so this needs non-standard ordering from Z.AI to trigger. Your migration fix (when a real id arrives for an index whose current id is synthetic, rename the ToolState + map entry) is correct and cheap — worth hardening even if unobserved. Also guard against empty-string `id` (`""` is non-nullish and would collapse all calls into one).

### F5 — LOW: `reasoning_text.delta` lacks `content_index` (your candidate #3, re-scoped)
- `src/responses.ts:479-485` emits `response.reasoning_text.delta` with no `content_index`. Codex requires it (`responses.rs:340-346`: matches only `(Some(delta), Some(content_index))`), so deltas are dropped → no live reasoning stream.

Tie this to F2: since the final item stores reasoning under **`summary`**, the consistent choice is to stream `response.reasoning_summary_text.delta` with `summary_index: 0` (handled at `responses.rs:332-339`) and emit `response.reasoning_summary_part.added` first (`responses.rs:425-431`). Alternatively keep `reasoning_text.delta` but add `content_index: 0` **and** move the text into the final item's `content: [{type:"reasoning_text", text}]`. Don't mix (summary in the item, content in the deltas).

### F6 — ACCEPT/DEFER: `web_search`, `image_generation`, and custom/freeform tools dropped (your candidate #4)
`normalizeTools` also drops `web_search`, `image_generation`, and `type: "custom"`/freeform tools (e.g. an apply_patch grammar tool). Z.AI Chat Completions can't natively serve these, and synthesizing them without a stable Codex `ToolName` mapping would be worse than dropping. **Agree:** keep dropping, but **log each dropped tool type** (you already have `summarizeResponsesRequest` at `server.ts:71-101` capturing `tool_types` — add an explicit `tools.dropped` debug event) and document the limitation.

### Minor note — reasoning on the *input* side couples to F2
`itemToMessages` turns inbound reasoning items into `{role:"assistant", content:"[reasoning]\n…"}` (`src/translate.ts:125-133`). Today this path is dead because reasoning items are never recorded (F2). **Once you fix F2, Codex will replay reasoning items next turn**, and this will inject `[reasoning]` blocks into the chat context — pollution that can confuse GLM. When you fix F2, also change the reasoning branch in `itemToMessages` to **drop** reasoning input items (`return []`), which is the standard Chat-Completions-bridge behavior.

---

## Apply now vs defer

**Apply now (compatibility-blocking):**
- **F1 + F1b** — namespace tool codec (request flatten + history encode + response decode). Primary user-visible breakage.
- **F2** — add `encrypted_content: null` to reasoning items. One-line-ish, fixes silent reasoning loss.
- **F3** — emit `error.code` as a string. Restores error messages.

**Apply now if cheap (recommended):**
- **F4** — synthetic→real id migration + empty-id guard.
- The input-side reasoning drop that pairs with F2.

**Defer / document:**
- **F5** — only after deciding summary-vs-content (do it alongside F2 for consistency; otherwise low priority since it's cosmetic streaming).
- **F6** — keep dropping; add a debug log + README note.

---

## Edge cases / tests to add
- **Namespace round-trip (translate):** request with `{type:"namespace", name:"mcp_fs", tools:[{type:"function", name:"read/file"}]}` → assert a sanitized, unique chat function name; assert prior `function_call {namespace:"mcp_fs", name:"read/file"}` input encodes to the *same* chat name; assert collision handling when two namespaces yield the same sanitized name.
- **Namespace decode (stream):** chat tool_call named with the encoded name → final `response.output_item.done` `function_call` has original `name` and separate `namespace`.
- **Reasoning item shape:** assert `output_item.done` (and `.added`) reasoning items include `encrypted_content` (null OK) and `summary:[{type:"summary_text",…}]`. A regression guard here directly prevents F2 recurring.
- **Error code type:** assert `errorResponse(...).error.code` is a string (and that the upstream message survives).
- **Tool id migration:** chunk 1 `{index:0, function:{name:"f", arguments:"{"}}` (no id), chunk 2 `{index:0, id:"call_real", function:{arguments:"}"}}` → exactly one `function_call`, name `f`, args `{}`, id `call_real`.
- **Dropped-tool logging:** request with `web_search`/`image_generation` → assert a debug event records the dropped types and the function tools still pass through.

## Verification notes
- **F2 is inferred from serde semantics + Codex's fixture asymmetry, not executed.** To make it incontrovertible, feed one of zodex's emitted reasoning JSON blobs to `serde_json::from_value::<codex_protocol::models::ResponseItem>` (expect `Err` before the fix, `Ok(Reasoning{..})` after); or run real Codex against zodex with a reasoning model and grep the Codex debug log for `failed to parse ResponseItem from output_item.done`.
- **F1:** run Codex with an MCP server configured and confirm a namespaced tool actually dispatches end-to-end (request reaches Z.AI as a flat function, response decodes back to `{namespace,name}`).
- After fixes: re-run `bun run typecheck`, `bun test`, `bun run build`, the direct smoke probe, and the cancellation probes (your existing green baseline).

---

VERDICT: FIXES_REQUIRED
