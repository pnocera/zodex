import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  aliasConflictWarnings,
  codexBaseInstructionsForCatalog,
  codexBaseInstructionsFromCatalog,
  codexProfileToml,
  glm52ModelCatalogJson,
  install,
  lockIsStale,
  modelCatalogPath,
  removeMarkedBlock,
  rotateBackups,
  upsertMarkedBlock,
} from "../src/install";
import { retryDelayMs } from "../src/upstream";

describe("install helpers", () => {
  test("writes a Responses wire API profile using ZAI_API_KEY", () => {
    const toml = codexProfileToml({
      home: "/tmp/zodex-home",
      host: "127.0.0.1",
      port: 31452,
    });
    expect(toml).toContain('env_key = "ZAI_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('model_reasoning_effort = "max"');
    expect(toml).toContain(
      'model_catalog_json = "/tmp/zodex-home/.codex/zai-glm52.models.json"',
    );
  });

  test("generates a single-model GLM-5.2 Codex catalog", () => {
    const catalog = JSON.parse(glm52ModelCatalogJson("base instructions"));
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      slug: "glm-5.2",
      display_name: "GLM-5.2",
      default_reasoning_level: "max",
      shell_type: "shell_command",
      visibility: "list",
      supports_reasoning_summaries: true,
      supports_parallel_tool_calls: true,
      supports_image_detail_original: false,
      context_window: 1000000,
      max_context_window: 1000000,
      input_modalities: ["text"],
      base_instructions: "base instructions",
    });
    expect(catalog.models[0]).not.toHaveProperty("default_service_tier");
    expect(catalog.models[0]).not.toHaveProperty("auto_compact_token_limit");
    expect(catalog.models[0]).not.toHaveProperty("comp_hash");
    expect(catalog.models[0]).not.toHaveProperty("auto_review_model_override");
    expect(catalog.models[0]).not.toHaveProperty("tool_mode");
    expect(catalog.models[0]).not.toHaveProperty("multi_agent_version");
    expect(catalog.models[0].supported_reasoning_levels).toEqual([
      {
        effort: "high",
        description: "Enhanced reasoning for everyday coding tasks",
      },
      {
        effort: "max",
        description: "Maximum reasoning for complex coding tasks",
      },
    ]);
  });

  test("selects preferred Codex base instructions from bundled catalog shape", () => {
    expect(
      codexBaseInstructionsFromCatalog({
        models: [
          { slug: "gpt-5.5", base_instructions: "first" },
          { slug: "gpt-5.3-codex", base_instructions: "preferred" },
        ],
      }),
    ).toBe("preferred");

    expect(
      codexBaseInstructionsFromCatalog({
        models: [
          { slug: "unknown", base_instructions: "" },
          { slug: "other", base_instructions: "fallback" },
        ],
      }),
    ).toBe("fallback");
  });

  test("falls back when Codex bundled catalog cannot be queried", async () => {
    const instructions = await codexBaseInstructionsForCatalog({
      codexCommand: "/path/that/does/not/exist",
    });

    expect(instructions).toContain("You are Codex");
  });

  test("install writes the model catalog and profile pointer", async () => {
    const home = await mkdtemp(join(tmpdir(), "zodex-install-"));
    try {
      const result = await install({
        home,
        zodexBin: "/tmp/zodex",
        codexBaseInstructions: "base instructions",
      });

      expect(result.modelCatalogPath).toBe(modelCatalogPath(home));
      const catalog = JSON.parse(
        await readFile(result.modelCatalogPath, "utf8"),
      );
      expect(catalog.models[0].base_instructions).toBe("base instructions");
      const profile = await readFile(result.profilePath, "utf8");
      expect(profile).toContain(
        `model_catalog_json = "${result.modelCatalogPath}"`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
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
    // T7: content outside the managed block must survive an update.
    expect(second).toContain("export PATH=/bin");
    expect(second.indexOf("export PATH=/bin")).toBeLessThan(
      second.indexOf("# >>> zodex aliases >>>"),
    );
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

  // T6: a non-numeric Retry-After (HTTP-date form) is not parseable as seconds,
  // so it must fall back to exponential backoff rather than yield NaN.
  test("429 retry delay falls back for HTTP-date Retry-After", () => {
    expect(retryDelayMs("Wed, 21 Oct 2025 07:28:00 GMT", 0)).toBe(500);
    expect(retryDelayMs("Wed, 21 Oct 2025 07:28:00 GMT", 2)).toBe(2000);
  });

  // N10: keep only the newest `keep` timestamped backups; never touch the stable
  // suffix-less base backup.
  test("rotateBackups prunes old timestamped backups but keeps the base", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zodex-backups-"));
    try {
      const base = join(dir, ".zshrc.zodex.bak");
      await writeFile(base, "stable", "utf8"); // suffix-less, must survive
      for (const ts of [100, 200, 300, 400]) {
        await writeFile(`${base}.${ts}`, String(ts), "utf8");
      }
      await rotateBackups(base, 2);

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual([
        ".zshrc.zodex.bak",
        ".zshrc.zodex.bak.300",
        ".zshrc.zodex.bak.400",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // R3-N1: a lockfile owned by a dead pid is reclaimable; a live/ambiguous owner
  // is not. Guards against the reclaim path silently reverting to always-wait.
  test("lockIsStale reclaims a dead owner but not a live/ambiguous one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zodex-lock-"));
    try {
      const lock = join(dir, ".zshrc.zodex.lock");

      await writeFile(lock, String(process.pid), "utf8"); // self = alive
      expect(await lockIsStale(lock)).toBe(false);

      await writeFile(lock, "2147483646", "utf8"); // a pid that cannot exist
      expect(await lockIsStale(lock)).toBe(true);

      await writeFile(lock, "", "utf8"); // just created, pid not written yet
      expect(await lockIsStale(lock)).toBe(false);

      await writeFile(lock, "not-a-pid", "utf8"); // unknown owner
      expect(await lockIsStale(lock)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
