Please review the design milestone for a new local Codex-to-Z.AI gateway.

Repository: /home/pierre/Tools/codex-bridge/zodex

Scope:
- Review docs/design.md only.
- Do not edit files.
- Focus on correctness, missing risks, Codex Responses compatibility, Z.AI bridge feasibility, and whether the proposed install behavior is safe.

User intent:
- Build a lightweight Bun gateway for Codex to use Z.AI GLM 5.2.
- Avoid LiteLLM as runtime.
- Borrow useful protocol ideas from the locally cloned bridge repos.
- Ask Claude for reviews at strategic milestones.

Non-negotiable constraints:
- Do not store ZAI_API_KEY in files.
- Do not rewrite ~/.codex/config.toml.
- Use user-level Codex profile file for the Z.AI provider.
- Aliases must run Codex with --dangerously-bypass-approvals-and-sandbox.
- Prefer a small auditable bridge over a broad router.

Validation already run:
- The design is source-grounded against the current Codex manual for profile files and custom provider config.
- Earlier smoke checks showed both local bridge candidates can reach Z.AI GLM 5.2 for text and tool-call cases.

Required output structure:
1. Findings first, ordered by severity, each with a concrete reason and suggested fix.
2. Open questions or residual risks.
3. Verification notes.
4. Final line exactly one of:
   VERDICT: GO
   VERDICT: FIXES_REQUIRED
