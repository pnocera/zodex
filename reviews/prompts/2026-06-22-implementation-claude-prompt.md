Please review the implementation milestone for the local Codex-to-Z.AI gateway.

Repository: /home/pierre/Tools/codex-bridge/zodex

Scope:
- Review the current code and docs diff.
- Do not edit files.
- Focus on correctness, Codex Responses compatibility, Z.AI bridge behavior, installer safety, executable build behavior, and test gaps.

User intent:
- Build a lightweight Bun gateway for Codex to use Z.AI GLM 5.2.
- Avoid LiteLLM as runtime, but borrow its useful Responses bridge behavior.
- Provide a self executable build.
- Add a Codex profile and zsh aliases after review gates pass.
- Ask Claude for code reviews at strategic milestones.

Important context:
- Current Codex manual says profile files are loaded as ~/.codex/<profile>.config.toml with top-level keys when selected by --profile.
- The previous design review raised FIXES_REQUIRED. The implementation keeps the modern profile-file approach because it is manual-grounded, but it made provider/profile config explicit and added wire_api, stream idle timeout, warnings, live-key failure, /v1/models, lowercase model forwarding, cumulative delta handling, simple JSON argument repair, and content_filter failure mapping.

Validation already run:
- bun run typecheck
- bun test
- bun run build
- Live non-streaming smoke through ./dist/zodex returned completed response text OK.
- Live streaming text smoke returned response.completed and text OK.
- Live streaming tool smoke returned get_weather with arguments {"city":"Paris"} in response.completed.output.
- GET /v1/models returns glm-5.2.

Required output structure:
1. Findings first, ordered by severity, each with a concrete reason and suggested fix.
2. Open questions or residual risks.
3. Verification notes.
4. Final line exactly one of:
   VERDICT: GO
   VERDICT: FIXES_REQUIRED
