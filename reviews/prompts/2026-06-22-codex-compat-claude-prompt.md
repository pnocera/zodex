# Claude Review Prompt: zodex vs local Codex Responses compatibility

Repo under review: `/home/pierre/Tools/codex-bridge/zodex`
Reference Codex source: `/home/pierre/Tools/codex-bridge/codex`

User intent:
- Review current zodex against the local Codex source.
- Identify possible compatibility bugs.
- Advise on fixes that make sense.
- Do not edit files.

Current zodex status:
- Debug mode and cancellation fixes are already implemented but uncommitted.
- Validation already run after cancellation fixes:
  - `bun run typecheck`
  - `bun test`
  - `bun run build`
  - direct zodex/Codex smoke returned `OK`
  - cancellation probes verified no `Controller is already closed` after stream cancel.

Relevant zodex files:
- `src/translate.ts`
- `src/responses.ts`
- `src/types.ts`
- `src/server.ts`
- `src/upstream.ts`
- `tests/translate.test.ts`
- `tests/responses.test.ts`

Reference Codex source points:
- `codex-rs/codex-api/src/sse/responses.rs`
  - `process_responses_event` handles:
    - `response.output_item.done`
    - `response.output_text.delta`
    - `response.custom_tool_call_input.delta`
    - `response.reasoning_summary_text.delta`
    - `response.reasoning_text.delta` only when `delta` and `content_index` exist
    - `response.created`
    - `response.failed`
    - `response.incomplete`
    - `response.completed`
    - `response.output_item.added`
    - `response.reasoning_summary_part.added`
  - It ignores `response.function_call_arguments.delta`.
  - `ResponseCompleted.usage` is now optional.
- `codex-rs/protocol/src/models.rs`
  - `ResponseItem::FunctionCall` has fields:
    - `id: Option<String>`
    - `name: String`
    - `namespace: Option<String>`
    - `arguments: String`
    - `call_id: String`
    - `metadata: Option<ResponseItemMetadata>`
- `codex-rs/core/src/tools/router.rs`
  - `ToolRouter::build_tool_call` converts `ResponseItem::FunctionCall { namespace, name, ... }` into `ToolName::new(namespace, name)`.
- `codex-rs/tools/src/responses_api.rs`
  - Codex sends direct tools as `{ type: "function", name, description, parameters }`.
  - Codex sends namespace tools as `{ type: "namespace", name, description, tools: [{ type: "function", name, description, parameters }] }`.
- `codex-rs/core/src/tools/mod.rs`
  - Legacy flat tool names concatenate `namespace + name`.

Observed zodex behavior:
- In `/tmp/zodex-litellm-review-debug.log`, Codex requests included `tools: 19` with tool types:
  - 13 direct `function` tools
  - 4 `namespace` tools
  - `web_search`
  - `image_generation`
- zodex translated only the 13 direct function tools. It dropped namespace, web_search, and image_generation tools.

Candidate findings / proposed fixes:

1. Namespace tools are silently dropped.
   - Impact: MCP, multi-agent, and other namespaced direct model tools cannot be called through Z.AI even when Codex exposed them.
   - Proposed fix: flatten namespace tools into Chat Completions function tools using a reversible name codec.
     - Build codec from `request.tools`.
     - For direct functions: map chat name to `{ name, namespace: undefined }`.
     - For namespace functions: map sanitized/unique chat function name to `{ namespace, name }`.
     - Include namespace in descriptions so the model sees origin.
     - When translating prior `function_call` input items, encode `{ namespace, name }` to the same chat function name.
     - When streaming Chat Completion tool calls back to Codex, decode chat function names and emit final `response.output_item.done` function_call item with original `namespace` and `name`.
   - Concern: Codex's `flat_tool_name` simply concatenates `namespace + name`, but Chat Completion function names may reject `/`, `.`, or other characters. zodex probably needs a sanitizer plus collision handling.

2. Streaming tool-call id correlation can split one call.
   - Current `ResponsesStreamTranslator.toolDelta` chooses:
     `const id = delta.id ?? this.toolIdByIndex.get(index) ?? "call_${index}"`.
   - If the first chunk for a tool call has no id but later chunks provide one, zodex creates `call_0` first and then a second tool state with the real id, losing earlier name/argument deltas.
   - Proposed fix: prefer the existing id for an index once assigned, but if the existing id is synthetic and a real id arrives later, migrate the ToolState and map entry to the real id.

3. Reasoning deltas are mostly ignored by Codex.
   - zodex emits `response.reasoning_text.delta` without `content_index`, so Codex ignores it.
   - zodex eventually emits `response.output_item.done` with a reasoning item summary, so reasoning is not completely lost.
   - Proposed fix: either add `content_index: 0` to raw reasoning deltas, or leave unchanged to avoid exposing raw reasoning differently. Please advise.

4. `web_search` and `image_generation` are dropped.
   - Codex sends them as first-party Responses tool types, not namespace/function tools.
   - zodex cannot make Z.AI natively support those.
   - Possible approach: keep dropping for now and document/debug-log unsupported tool types; do not synthesize function calls unless Codex has a stable registered `ToolName` mapping for them.

Please review these candidate findings and proposed fixes.

Required output:
- Findings first, ordered by severity, with concrete source references.
- Advice on which fixes to apply now vs defer.
- Any edge cases/test cases to add.
- Verification notes.
- End with exactly one final verdict line:
  - `VERDICT: GO`
  - or `VERDICT: FIXES_REQUIRED`
