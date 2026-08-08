import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import type { AppConfig, ConcurrencyConfig, PromptMode, StdinMode, ToolConfig } from "./types.ts";
import { builtinTools } from "./adapters/catalog.ts";
import { fileExists, fileReadText } from "./util/runtime.ts";
import { expandHome } from "./util/messages.ts";

const __dirname =
  import.meta.dirname ??
  (typeof (import.meta as { dir?: string }).dir !== "undefined"
    ? (import.meta as { dir: string }).dir
    : fileURLToPath(new URL(".", import.meta.url)));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "../config/default.json");

export function getXdgConfigPath(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME;
  const base = xdgHome && xdgHome.trim() !== "" ? xdgHome : join(process.env.HOME ?? "~", ".config");
  return join(base, "prompt-to-api", "config.toml");
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const str = String(value).toLowerCase().trim();
  if (["0", "false", "no", "off"].includes(str)) return false;
  if (["1", "true", "yes", "on"].includes(str)) return true;
  return undefined;
}

function asPromptMode(v: unknown): PromptMode {
  const s = String(v ?? "arg");
  if (s === "stdin" || s === "flag" || s === "combined" || s === "none" || s === "arg") return s;
  return "arg";
}

function asStdinMode(v: unknown): StdinMode {
  const s = String(v ?? "auto");
  if (s === "prompt" || s === "context" || s === "none" || s === "auto") return s;
  return "auto";
}

function parseConfigFile(content: string, filePath: string): unknown {
  if (filePath.endsWith(".json")) return JSON.parse(content);
  if (filePath.endsWith(".toml")) return parseToml(content);
  try {
    return JSON.parse(content);
  } catch {
    return parseToml(content);
  }
}

function normalizeTool(agentId: string, a: Record<string, unknown>): ToolConfig {
  const enabled = a.enabled !== undefined ? Boolean(a.enabled) : true;
  const command = Array.isArray(a.command)
    ? a.command.map(String)
    : typeof a.command === "string"
      ? [String(a.command)]
      : [agentId];
  return {
    enabled,
    command,
    promptMode: asPromptMode(a.promptMode ?? a.prompt_mode),
    ...(a.promptFlag !== undefined || a.prompt_flag !== undefined
      ? { promptFlag: String(a.promptFlag ?? a.prompt_flag) }
      : {}),
    stdinMode: asStdinMode(a.stdinMode ?? a.stdin_mode),
    forcePromptChannel: Boolean(a.forcePromptChannel ?? a.force_prompt_channel),
    ...(a.stdinPromptArg !== undefined || a.stdin_prompt_arg !== undefined
      ? { stdinPromptArg: String(a.stdinPromptArg ?? a.stdin_prompt_arg) }
      : {}),
    ...(a.modelFlag !== undefined || a.model_flag !== undefined
      ? { modelFlag: String(a.modelFlag ?? a.model_flag) }
      : {}),
    trustedArgs: Array.isArray(a.trustedArgs)
      ? a.trustedArgs.map(String)
      : Array.isArray(a.trusted_args)
        ? a.trusted_args.map(String)
        : [],
    extraArgs: Array.isArray(a.extraArgs)
      ? a.extraArgs.map(String)
      : Array.isArray(a.extra_args)
        ? a.extra_args.map(String)
        : [],
    env:
      a.env && typeof a.env === "object"
        ? Object.fromEntries(Object.entries(a.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {},
    aliases: Array.isArray(a.aliases) ? a.aliases.map(String) : [],
    ...(a.description !== undefined ? { description: String(a.description) } : {}),
    ...(a.defaultModel !== undefined || a.default_model !== undefined
      ? { defaultModel: String(a.defaultModel ?? a.default_model) }
      : {}),
    ...(a.cwd !== undefined && a.cwd !== null ? { cwd: expandHome(String(a.cwd)) } : {}),
  };
}

export function normalizeConfig(raw: unknown): Partial<AppConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;

  const host = r.host !== undefined ? String(r.host) : undefined;
  const port = r.port !== undefined && r.port !== null ? Number(r.port) : undefined;
  const authToken =
    r.authToken !== undefined ? r.authToken : r.auth_token !== undefined ? r.auth_token : undefined;
  const rawDefaultCwd = r.defaultCwd ?? r.default_cwd;
  const defaultCwd =
    rawDefaultCwd !== undefined && rawDefaultCwd !== null
      ? expandHome(String(rawDefaultCwd))
      : undefined;
  const trusted = parseBoolean(r.trusted);
  const timeoutMs =
    r.timeoutMs !== undefined && r.timeoutMs !== null
      ? Number(r.timeoutMs)
      : r.timeout_ms !== undefined && r.timeout_ms !== null
        ? Number(r.timeout_ms)
        : undefined;

  let concurrency: Partial<ConcurrencyConfig> | undefined;
  const rawPool = (r.concurrency ?? r.pool) as Record<string, unknown> | undefined;
  if (rawPool && typeof rawPool === "object") {
    concurrency = {
      ...(rawPool.maxGlobal !== undefined
        ? { maxGlobal: Number(rawPool.maxGlobal) }
        : rawPool.max_global !== undefined
          ? { maxGlobal: Number(rawPool.max_global) }
          : {}),
      ...(rawPool.maxPerAgent !== undefined
        ? { maxPerAgent: Number(rawPool.maxPerAgent) }
        : rawPool.max_per_agent !== undefined
          ? { maxPerAgent: Number(rawPool.max_per_agent) }
          : {}),
    };
  }

  let tools: Record<string, ToolConfig> | undefined;
  const rawTools = (r.tools ?? r.agents) as Record<string, unknown> | undefined;
  if (rawTools && typeof rawTools === "object") {
    tools = {};
    for (const [id, toolRaw] of Object.entries(rawTools)) {
      if (!toolRaw || typeof toolRaw !== "object") continue;
      tools[id] = normalizeTool(id, toolRaw as Record<string, unknown>);
    }
  }

  return {
    ...(host !== undefined && { host }),
    ...(port !== undefined && { port }),
    ...(authToken !== undefined && { authToken: (authToken as string | null) ?? null }),
    ...(defaultCwd !== undefined && { defaultCwd: defaultCwd ?? null }),
    ...(trusted !== undefined && { trusted }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(concurrency !== undefined && { concurrency: concurrency as ConcurrencyConfig }),
    ...(tools !== undefined && { tools }),
  };
}

function deepMergeTools(
  base: Record<string, ToolConfig>,
  over: Record<string, ToolConfig> | undefined,
): Record<string, ToolConfig> {
  if (!over) return { ...base };
  const out: Record<string, ToolConfig> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = { ...(out[k] ?? {}), ...v };
  }
  return out;
}

export async function loadConfig(specifiedPath?: string): Promise<AppConfig> {
  let fileRaw: unknown = {};
  if (await fileExists(DEFAULT_CONFIG_PATH)) {
    fileRaw = parseConfigFile(await fileReadText(DEFAULT_CONFIG_PATH), DEFAULT_CONFIG_PATH);
  }
  const fromFile = normalizeConfig(fileRaw);

  let userPath = specifiedPath ?? process.env.PROMPT_TO_API_CONFIG;
  if (!userPath) {
    const xdg = getXdgConfigPath();
    if (await fileExists(xdg)) userPath = xdg;
  }
  let fromUser: Partial<AppConfig> = {};
  if (userPath && (await fileExists(userPath))) {
    fromUser = normalizeConfig(parseConfigFile(await fileReadText(userPath), userPath));
  }

  const env: Partial<AppConfig> = {
    ...(process.env.PROMPT_TO_API_HOST ? { host: process.env.PROMPT_TO_API_HOST } : {}),
    ...(process.env.PROMPT_TO_API_PORT ? { port: Number(process.env.PROMPT_TO_API_PORT) } : {}),
    ...(process.env.PROMPT_TO_API_TOKEN !== undefined
      ? { authToken: process.env.PROMPT_TO_API_TOKEN || null }
      : {}),
    ...(process.env.PROMPT_TO_API_CWD
      ? { defaultCwd: expandHome(process.env.PROMPT_TO_API_CWD) }
      : {}),
    ...(parseBoolean(process.env.PROMPT_TO_API_TRUSTED) !== undefined
      ? { trusted: parseBoolean(process.env.PROMPT_TO_API_TRUSTED)! }
      : {}),
    ...(process.env.PROMPT_TO_API_TIMEOUT_MS
      ? { timeoutMs: Number(process.env.PROMPT_TO_API_TIMEOUT_MS) }
      : {}),
  };

  const tools = deepMergeTools(
    builtinTools,
    deepMergeTools(fromFile.tools ?? {}, fromUser.tools),
  );

  const concurrency: ConcurrencyConfig = {
    maxGlobal: fromUser.concurrency?.maxGlobal ?? fromFile.concurrency?.maxGlobal ?? 8,
    maxPerAgent: fromUser.concurrency?.maxPerAgent ?? fromFile.concurrency?.maxPerAgent ?? 2,
  };

  return {
    host: env.host ?? fromUser.host ?? fromFile.host ?? "127.0.0.1",
    port: env.port ?? fromUser.port ?? fromFile.port ?? 8788,
    authToken: env.authToken !== undefined ? env.authToken : (fromUser.authToken ?? fromFile.authToken ?? null),
    defaultCwd:
      env.defaultCwd !== undefined
        ? env.defaultCwd
        : (fromUser.defaultCwd ?? fromFile.defaultCwd ?? expandHome("~/.config/prompt-to-api/cwd")),
    trusted: env.trusted ?? fromUser.trusted ?? fromFile.trusted ?? true,
    timeoutMs: env.timeoutMs ?? fromUser.timeoutMs ?? fromFile.timeoutMs ?? 600_000,
    concurrency,
    tools,
  };
}
