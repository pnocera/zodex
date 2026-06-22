Review the current zodex working-tree diff only.

Repo: /home/pierre/Tools/codex-bridge/zodex

User intent:
- zodex should generate a small Codex model catalog JSON for Z.AI GLM-5.2.
- The generated Codex profile should reference that catalog so Codex no longer warns that model metadata for `glm-5.2` is missing.
- The model metadata should be relevant and correct for GLM-5.2.
- The standalone `dist/zodex` build should keep working.

Changed areas to review:
- README.md
- src/cli.ts
- src/constants.ts
- src/install.ts
- src/translate.ts
- tests/install.test.ts
- tests/translate.test.ts

Important context:
- Codex's custom catalog expects a JSON object shaped like `ModelsResponse`, with a `models` array of `ModelInfo` entries.
- `base_instructions` is live prompt material in Codex, so this patch asks `codex debug models --bundled` for the installed Codex base instructions and falls back only if that fails.
- The generated profile now sets `model_reasoning_effort = "max"`.
- zodex maps Codex reasoning efforts to Z.AI's `high`/`max` values before sending upstream.

Validation already run:
- `bun run typecheck`
- `bun test`
- `bun run build`
- `./dist/zodex install`
- `codex debug models -c 'model_catalog_json="/home/pierre/.codex/zai-glm52.models.json"'`
- `./dist/zodex codex exec "Reply with exactly: ok"` succeeded, showed `reasoning effort: max`, and did not emit the fallback metadata warning.

Please review for:
- Incorrect Codex model catalog schema assumptions.
- Incorrect GLM-5.2 metadata choices.
- Install-time robustness issues.
- Any regression risk in translator reasoning effort handling.
- Missing tests.

Do not edit files. Return findings first, then open questions or residual risks, then verification notes.

End with exactly one of:
VERDICT: GO
VERDICT: FIXES_REQUIRED
