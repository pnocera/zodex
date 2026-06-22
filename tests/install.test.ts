import { describe, expect, test } from "bun:test";
import {
  aliasConflictWarnings,
  codexProfileToml,
  removeMarkedBlock,
  upsertMarkedBlock,
} from "../src/install";
import { retryDelayMs } from "../src/upstream";

describe("install helpers", () => {
  test("writes a Responses wire API profile using ZAI_API_KEY", () => {
    const toml = codexProfileToml({ host: "127.0.0.1", port: 31452 });
    expect(toml).toContain('env_key = "ZAI_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
  });

  test("upserts marked alias block without duplication", () => {
    const first = upsertMarkedBlock(
      "export PATH=/bin\n",
      "# >>> zodex aliases >>>\na\n# <<< zodex aliases <<<",
    );
    const second = upsertMarkedBlock(
      first,
      "# >>> zodex aliases >>>\nb\n# <<< zodex aliases <<<",
    );
    expect(second.match(/zodex aliases/g)?.length).toBe(2);
    expect(second).toContain("\nb\n");
    expect(second).not.toContain("\na\n");
  });

  test("warns about aliases outside the managed block", () => {
    expect(aliasConflictWarnings("alias cx='codex'\n")).toEqual([
      "Existing cx alias outside the zodex managed block was left unchanged.",
    ]);
  });

  test("removes only the managed alias block", () => {
    const content = [
      "export PATH=/bin",
      "# >>> zodex aliases >>>",
      "alias cx='codex'",
      "# <<< zodex aliases <<<",
      "alias other='ok'",
      "",
    ].join("\n");

    expect(removeMarkedBlock(content)).toBe("export PATH=/bin\nalias other='ok'\n");
  });

  test("429 retry delay falls back when Retry-After is absent", () => {
    expect(retryDelayMs(null, 0)).toBe(500);
    expect(retryDelayMs("", 1)).toBe(1000);
    expect(retryDelayMs("2", 1)).toBe(2000);
  });
});
