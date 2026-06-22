I have everything I need. Both reference implementations independently confirm the Codex-side contract, which lets me validate the design's claims precisely. Here is the review.

---

# Review — `docs/design.md` (zodex gateway, design milestone)

The translation/streaming half of this design is solid and, notably, picks the *better* idea from each reference where they diverge (populated `response.completed.output`, `sequence_number`, `content_part`/`reasoning_text` events — all from `zai-codex-bridge`, all of which `codex-zai-proxy` gets wrong). The weakness is the **install / Codex-profile wiring**, which is load-bearing and underspecified, plus a few robustness features the references added precisely because they hit real GLM failures.

## 1. Findings (ordered by severity)

### F1 — [Blocker] The profile-loading mechanism is undefined; `--profile zai-glm52` will not find a profile that lives only in a standalone file
**Reason:** Codex loads exactly one config: `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). It does **not** auto-merge sibling files like `~/.codex/zai-glm52.config.toml`. Both local references confirm this empirically — every working setup puts `[model_providers.*]` / `[profiles.*]` *inside* `~/.codex/config.toml` (`codex-zai-proxy/README.md` "Codex Configuration"; `zai-codex-bridge/README.md` §2; `zai-codex-bridge/docs/guide.md:64` "The file `~/.codex/config.toml` must contain…"). As written, the constraints collide: *(a)* don't touch `config.toml`, *(b)* keep the profile in a separate file, *(c)* alias is exactly `codex --profile zai-glm52 …` with no `CODEX_HOME`. Under the standard loader those cannot all hold — `--profile zai-glm52` will error with profile-not-found.
**Fix:** State the exact load path in the doc and make the alias reflect it. The reconciliation that honors every constraint is `CODEX_HOME` redirection: write `~/.codex-zai/config.toml` (the "user-level Codex profile file"), leave `~/.codex/config.toml` pristine, and make the alias `cxz='CODEX_HOME=$HOME/.codex-zai codex --profile zai-glm52 --dangerously-bypass-approvals-and-sandbox'`. If instead the design relies on a profile-file *include* feature, cite the exact Codex manual section that documents it — this is the single most load-bearing claim and it is currently implicit. (Note the `CODEX_HOME` route also isolates `auth.json`/history/sessions/MCP — call that out as intended behavior.)

### F2 — [Blocker] The provider/profile TOML is unspecified; `wire_api = "responses"` is never mentioned
**Reason:** The bridge only works if Codex *sends* Responses-format requests to it, which requires `wire_api = "responses"` on the provider. Every reference sets it explicitly and `codex-zai-proxy/README.md` notes Codex "now requires `wire_api = "responses"`." The design lists the bridge endpoints but never specifies the provider keys, so the most critical one can silently be wrong (defaulting to chat → bridge bypassed or 4xx). `base_url` must also point at the bridge, not Z.AI.
**Fix:** Enumerate the profile/provider block, e.g.:
```toml
[model_providers.zai_glm52]
name = "Z.AI GLM via zodex"
base_url = "http://127.0.0.1:31452/v1"
env_key = "ZAI_API_KEY"
wire_api = "responses"
stream_idle_timeout_ms = 3000000   # see F5
[profiles.zai-glm52]
model = "glm-5.2"
model_provider = "zai_glm52"
```

### F3 — [High / Security] The dangerous-bypass aliases are an always-on, global safety-off switch, and `cx` extends it beyond the Z.AI path
**Reason:** You explicitly require `--dangerously-bypass-approvals-and-sandbox`, so this is not a "don't do it" — but the design's safety question deserves an honest blast-radius statement. The flag disables **both** approval prompts and the sandbox: any command the model emits runs immediately, with full user privileges, no confirmation, no FS/network containment. Crucially, `cx` (the non-Z.AI alias) binds the bypass to the user's **default** profile, so installing zodex silently strips the sandbox from *normal* Codex sessions too — a scope expansion past "a Z.AI gateway." Combined with a custom local gateway, any bug or prompt-injection (from repo files or tool output) that steers the model becomes arbitrary code execution.
**Fix (respecting the constraint):** Keep the dangerous behavior opt-in by name — consider scoping the bypass to `cxz` only and leaving `cx` sandboxed, or at minimum document loudly that `cx` is unsandboxed. Have `install` print exactly what it added and a one-line warning. Confirm the bridge binds `127.0.0.1` only (design says it does — good; keep it). Recommend use only in trusted working dirs. State explicitly in the doc that this is an accepted, user-owned risk.

### F4 — [Medium] API-key delivery vs. "never write secrets" is unspecified and can fail Codex-side before the bridge is even reached
**Reason:** With `env_key` set, Codex requires that env var to be exported or it errors *before* calling the bridge (`zai-codex-bridge/README.md:86` keeps `OPENAI_API_KEY` "because Codex expects that key name"; `export …` is mandatory). Separately, the bridge itself needs `ZAI_API_KEY` in its own process env (both references prioritize their own env over the inbound header — `main.py:33,608`; `server.js:595-606`). "Never writes secrets" therefore implies a manual export step the design doesn't mention, and a missing key yields a confusing Codex-side failure.
**Fix:** Specify `env_key`, document that `ZAI_API_KEY` must be exported in the shell (it feeds both Codex's check and the bridge), and have the bridge **fail fast with a clear message** when it's unset (mirror `main.py:608`). Note that under F1's `CODEX_HOME` route the key still comes from the live shell env, so no secret lands on disk.

### F5 — [Medium] Robustness features the references added for real GLM failures are absent
**Reason:** These weren't gold-plating in the references — they were bug fixes:
- **Malformed tool-call JSON:** GLM streams occasionally yield invalid arguments JSON; `codex-zai-proxy:_validate_and_fix_json` (135-153) repairs unbalanced braces before emitting, otherwise Codex's tool executor breaks.
- **Cumulative-vs-incremental deltas:** `zai-codex-bridge:computeDelta` (297-322) guards against providers that stream full-content-so-far and duplicate/overlap boundaries — naive concatenation would double text.
- **Slow first token:** GLM-5.2 reasoning can delay first event; `zai-codex-bridge` recommends `stream_idle_timeout_ms = 3000000` in the provider config or Codex times out.

**Fix:** Add an explicit "Robustness" subsection adopting argument-JSON repair, safe delta computation, the stream idle timeout, and upstream-status handling beyond the bare "`response.failed` for upstream errors" (cover non-200, timeouts, and `finish_reason: content_filter` → `response.failed`, as `server.js:985-996` does).

### F6 — [Low–Med] `.zshrc` editing is sound in concept but under-hardened
**Reason:** Marked, idempotent, secret-free block is the right call. Gaps: assumes zsh + an existing `~/.zshrc`; no mention of atomic write/backup; no uninstall; no handling of a pre-existing conflicting `cx`/`cxz` alias outside the block.
**Fix:** Create the file if absent, back it up before first edit, write atomically (temp + rename) with clear `# >>> zodex >>>` / `# <<< zodex <<<` sentinels, warn on conflicting prior aliases, and provide an `uninstall` that removes only the block.

### F7 — [Low] `/v1/models` and the model list are inconsistent
**Reason:** `/v1/models` appears only under Verification, not in the endpoints/runtime list, yet Codex may probe it; and the design's default is `glm-5.2` while neither reference's model list knows that name (`main.py:38` = glm-5/5.1/4.7; `server.js:1462` = GLM-4.7). Z.AI also wants the model lowercased (`server.js:418`).
**Fix:** List `GET /v1/models` as a first-class endpoint returning `glm-5.2`, and lowercase the model before forwarding upstream.

### F8 — [Low] Event *types* are listed but required *fields* aren't pinned
**Reason:** Codex's Rust SSE deserializer is strict; events silently drop if `item_id` / `output_index` / `content_index` are missing. `codex-zai-proxy` omits `item_id` on text deltas and `sequence_number` entirely — the design rightly follows `zai-codex-bridge` instead, but the doc only names event types.
**Fix:** Note that each event must carry the fields `zai-codex-bridge` emits (`item_id`, `output_index`, `content_index`, monotonic `sequence_number`), and that `response.completed.response.output` must contain the function_call items so Codex can execute them and return `function_call_output`.

## 2. Open questions / residual risks
- **Does current Codex support loading a per-profile file from `CODEX_HOME` (or an `include`)?** The entire separate-file approach rests on this. The design claims it's "source-grounded against the current Codex manual" — please cite the exact section. If no such feature exists, F1's `CODEX_HOME` redirect is the fix.
- **System-role acceptance by Z.AI.** The design merges everything into a leading `system` message (`codex-zai-proxy` approach). But `zai-codex-bridge` defaults `ALLOW_SYSTEM=0` and wraps instructions as `[INSTRUCTIONS]…` in the first *user* message, and Z.AI has historically returned `"Incorrect role information"` (code 1214). GLM-5.2 may be fine, but keep a fallback path in mind.
- **Reasoning round-trip.** GLM-5.2 emits `reasoning_content` (good — design maps it). Confirm inbound `reasoning` items in `input[]` are tolerated/dropped (both references drop or summarize them) and test a multi-turn session with reasoning + tool calls, which is where mismatches surface.
- **`env_key` choice.** `ZAI_API_KEY` vs the `OPENAI_API_KEY` convention `zai-codex-bridge` uses — pick one and ensure the bridge ignores whatever Codex forwards and uses its own env (both references already do).

## 3. Verification notes
- Read in full: `docs/design.md`; both candidate sources (`codex-zai-proxy/proxy/main.py` 738 L, `zai-codex-bridge/src/server.js` 1488 L); both READMEs, `codex-zai-proxy/CONTEXT.md`, `codex-zai-proxy/setup.sh`, `zai-codex-bridge/docs/guide.md` (config sections).
- Cross-checked each protocol claim against source: system-message consolidation (`main.py:328-330`), tool normalization (`main.py:179-204`, `server.js:449-491`), `max_output_tokens` mapping (design says `max_tokens` = `server.js:434`, but `codex-zai-proxy:345` maps `max_completion_tokens` — a real divergence between the references; pick the one Z.AI's paas/v4 actually accepts, almost certainly `max_tokens`), and the full streaming event set (`server.js:651-1232`).
- Confirmed the required Codex contract (`wire_api="responses"`, provider+profile in `config.toml`, `base_url`, `env_key`, `stream_idle_timeout_ms`) from *both* references independently — this is what drives F1, F2, F4, F5.
- Did not edit any files. Note: `reviews/2026-06-22-design-claude-review.md.tmp` exists but is empty; I left it untouched per scope.
- Not verified (no live calls): actual Z.AI `glm-5.2` wire behavior and whether current Codex auto-loads a per-profile file — both flagged as open questions.

The translation/streaming design is GO-quality. The install/profile-wiring section (F1, F2) would not work end-to-end as written, and F3 needs an explicit safety statement — these are in-scope and blocking.

VERDICT: FIXES_REQUIRED
