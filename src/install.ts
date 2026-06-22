import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ALIAS_BLOCK_END,
  ALIAS_BLOCK_START,
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CATALOG_FILENAME,
  DEFAULT_PORT,
  DEFAULT_PROFILE_NAME,
  DEFAULT_PROVIDER_ID,
} from "./constants";

export interface InstallOptions {
  home?: string;
  port?: number;
  host?: string;
  zodexBin?: string;
  codexCommand?: string;
  codexBaseInstructions?: string;
  modelCatalogPath?: string;
}

const CODEX_BASE_INSTRUCTION_MODEL_PREFERENCE = [
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5-codex",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
];

const FALLBACK_CODEX_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent running in the Codex CLI. Work directly in the user's workspace, follow the provided developer and repository instructions, use tools carefully, and keep the user informed with concise progress updates.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.zodex.${process.pid}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, path);
}

function aliasBlock(zodexBin: string): string {
  return [
    ALIAS_BLOCK_START,
    "alias cx='codex --dangerously-bypass-approvals-and-sandbox'",
    `alias cxz='${zodexBin} codex'`,
    ALIAS_BLOCK_END,
  ].join("\n");
}

function defaultZodexBin(): string {
  return new URL("../bin/zodex", import.meta.url).pathname;
}

export function modelCatalogPath(home: string): string {
  return join(home, ".codex", DEFAULT_MODEL_CATALOG_FILENAME);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexBaseInstructionsFromCatalog(
  catalog: unknown,
): string | null {
  if (!isRecord(catalog) || !Array.isArray(catalog.models)) {
    return null;
  }

  const models = catalog.models.filter(isRecord);
  for (const slug of CODEX_BASE_INSTRUCTION_MODEL_PREFERENCE) {
    const model = models.find((candidate) => candidate.slug === slug);
    if (
      typeof model?.base_instructions === "string" &&
      model.base_instructions.trim()
    ) {
      return model.base_instructions;
    }
  }

  const firstModel = models.find(
    (candidate) =>
      typeof candidate.base_instructions === "string" &&
      candidate.base_instructions.trim(),
  );
  return typeof firstModel?.base_instructions === "string"
    ? firstModel.base_instructions
    : null;
}

export async function installedCodexBaseInstructions(
  codexCommand = "codex",
): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(codexCommand, ["debug", "models", "--bundled"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve(null);
      }
    }, 3000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(codexBaseInstructionsFromCatalog(JSON.parse(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function codexBaseInstructionsForCatalog(
  options: InstallOptions = {},
): Promise<string> {
  if (options.codexBaseInstructions?.trim()) {
    return options.codexBaseInstructions;
  }
  return (
    (await installedCodexBaseInstructions(options.codexCommand ?? "codex")) ??
    FALLBACK_CODEX_BASE_INSTRUCTIONS
  );
}

export function upsertMarkedBlock(
  content: string,
  block: string,
  start = ALIAS_BLOCK_START,
  end = ALIAS_BLOCK_END,
): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  let next: string;
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    next = `${content.slice(0, startIndex)}${block}${content.slice(
      endIndex + end.length,
    )}`;
  } else {
    const prefix = content.trimEnd();
    next = prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
  }
  return `${next.trimEnd()}\n`;
}

export function removeMarkedBlock(
  content: string,
  start = ALIAS_BLOCK_START,
  end = ALIAS_BLOCK_END,
): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return content;
  }
  return `${content.slice(0, startIndex).trimEnd()}\n${content.slice(endIndex + end.length).trimStart()}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n");
}

export function aliasConflictWarnings(content: string): string[] {
  const outsideManagedBlock = content.replace(
    new RegExp(`${ALIAS_BLOCK_START}[\\s\\S]*?${ALIAS_BLOCK_END}`, "m"),
    "",
  );
  const warnings: string[] = [];
  if (/^\s*alias\s+cx=/m.test(outsideManagedBlock)) {
    warnings.push("Existing cx alias outside the zodex managed block was left unchanged.");
  }
  if (/^\s*alias\s+cxz=/m.test(outsideManagedBlock)) {
    warnings.push("Existing cxz alias outside the zodex managed block was left unchanged.");
  }
  return warnings;
}

export function codexProfileToml(options: InstallOptions = {}): string {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const catalogPath =
    options.modelCatalogPath ?? modelCatalogPath(options.home ?? homedir());
  return [
    `model = "${DEFAULT_MODEL}"`,
    `model_reasoning_effort = "max"`,
    `model_provider = "${DEFAULT_PROVIDER_ID}"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    `[model_providers.${DEFAULT_PROVIDER_ID}]`,
    `name = "Z.AI GLM 5.2 via zodex"`,
    `base_url = "http://${host}:${port}"`,
    `env_key = "ZAI_API_KEY"`,
    `wire_api = "responses"`,
    `stream_idle_timeout_ms = 3000000`,
    "",
  ].join("\n");
}

export function glm52ModelCatalogJson(baseInstructions: string): string {
  return `${JSON.stringify(
    {
      models: [
        {
          slug: DEFAULT_MODEL,
          display_name: "GLM-5.2",
          description:
            "Z.AI GLM-5.2 coding model with 1M context, 128K max output, text input/output, tool calling, and high/max reasoning effort.",
          default_reasoning_level: "max",
          supported_reasoning_levels: [
            {
              effort: "high",
              description: "Enhanced reasoning for everyday coding tasks",
            },
            {
              effort: "max",
              description: "Maximum reasoning for complex coding tasks",
            },
          ],
          shell_type: "shell_command",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          additional_speed_tiers: [],
          service_tiers: [],
          availability_nux: null,
          upgrade: null,
          base_instructions: baseInstructions,
          model_messages: null,
          supports_reasoning_summaries: true,
          default_reasoning_summary: "auto",
          support_verbosity: false,
          default_verbosity: null,
          apply_patch_tool_type: null,
          web_search_tool_type: "text",
          truncation_policy: { mode: "tokens", limit: 10000 },
          supports_parallel_tool_calls: true,
          supports_image_detail_original: false,
          context_window: 1000000,
          max_context_window: 1000000,
          effective_context_window_percent: 95,
          experimental_supported_tools: [],
          input_modalities: ["text"],
          supports_search_tool: false,
          use_responses_lite: false,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export async function install(options: InstallOptions = {}): Promise<{
  modelCatalogPath: string;
  profilePath: string;
  zshrcPath: string;
  warnings: string[];
}> {
  const home = options.home ?? homedir();
  const zodexBin = options.zodexBin ?? defaultZodexBin();
  const codexDir = join(home, ".codex");
  const catalogPath = modelCatalogPath(home);
  const profilePath = join(codexDir, `${DEFAULT_PROFILE_NAME}.config.toml`);
  const zshrcPath = join(home, ".zshrc");
  const backupPath = `${zshrcPath}.zodex.bak`;

  await mkdir(codexDir, { recursive: true });
  const baseInstructions = await codexBaseInstructionsForCatalog(options);
  await writeAtomic(catalogPath, glm52ModelCatalogJson(baseInstructions));
  await writeAtomic(
    profilePath,
    codexProfileToml({ ...options, home, modelCatalogPath: catalogPath }),
  );

  const currentZshrc = await readText(zshrcPath);
  if (currentZshrc && !(await exists(backupPath))) {
    await copyFile(zshrcPath, backupPath);
  }
  const warnings = aliasConflictWarnings(currentZshrc);
  const updatedZshrc = upsertMarkedBlock(currentZshrc, aliasBlock(zodexBin));
  await writeAtomic(zshrcPath, updatedZshrc);

  return { modelCatalogPath: catalogPath, profilePath, zshrcPath, warnings };
}

export async function uninstall(options: InstallOptions = {}): Promise<{
  profilePath: string;
  zshrcPath: string;
}> {
  const home = options.home ?? homedir();
  const codexDir = join(home, ".codex");
  const profilePath = join(codexDir, `${DEFAULT_PROFILE_NAME}.config.toml`);
  const zshrcPath = join(home, ".zshrc");
  const currentZshrc = await readText(zshrcPath);
  await writeAtomic(zshrcPath, removeMarkedBlock(currentZshrc));
  return { profilePath, zshrcPath };
}
