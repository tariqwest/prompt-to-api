import type { AppConfig, ResolvedModel, ToolId, ToolSpec } from "../types.ts";
import { isCommandAvailable } from "../util/runtime.ts";

export class Registry {
  private readonly specs = new Map<ToolId, ToolSpec>();
  private readonly aliases = new Map<string, ToolId>();

  constructor(private readonly config: AppConfig) {
    for (const [toolId, cfg] of Object.entries(config.tools)) {
      if (!cfg?.enabled) continue;
      const spec = toSpec(toolId, cfg);
      this.specs.set(toolId, spec);
      this.aliases.set(toolId.toLowerCase(), toolId);
      for (const alias of cfg.aliases ?? []) {
        this.aliases.set(alias.toLowerCase(), toolId);
      }
    }
  }

  listToolIds(): ToolId[] {
    return [...this.specs.keys()];
  }

  getSpec(toolId: ToolId): ToolSpec | undefined {
    return this.specs.get(toolId);
  }

  /** Resolve OpenAI model string → tool + optional upstream model */
  resolveModel(model: string): ResolvedModel {
    const raw = String(model ?? "").trim();
    if (!raw) throw new Error("model is required");

    let rest = raw;
    if (rest.toLowerCase().startsWith("prompt/")) rest = rest.slice(7);
    else if (rest.toLowerCase().startsWith("prompt-")) rest = rest.slice(7);

    let toolKey = rest;
    let modelId: string | undefined;
    const slash = rest.indexOf("/");
    const colon = rest.indexOf(":");
    const sep = slash >= 0 ? slash : colon >= 0 ? colon : -1;
    if (sep >= 0) {
      toolKey = rest.slice(0, sep);
      modelId = rest.slice(sep + 1).trim() || undefined;
    }

    const toolId = this.aliases.get(toolKey.toLowerCase());
    if (!toolId) {
      const asAlias = this.aliases.get(rest.toLowerCase());
      if (!asAlias) {
        throw new Error(
          `Unknown model "${model}". Use prompt-<tool> or prompt-<tool>/<model>. Known tools: ${this.listToolIds().join(", ")}`,
        );
      }
      return this.defaultResolved(asAlias);
    }

    const spec = this.specs.get(toolId)!;
    const id = modelId ? `prompt-${toolId}/${modelId}` : `prompt-${toolId}`;
    return {
      id,
      toolId,
      modelId: modelId ?? spec.defaultModel,
      ownedBy: `prompt-${toolId}`,
      displayName: modelId ? `${toolId}/${modelId}` : toolId,
    };
  }

  defaultResolved(toolId: ToolId): ResolvedModel {
    const spec = this.specs.get(toolId);
    if (!spec) throw new Error(`Unknown tool: ${toolId}`);
    return {
      id: `prompt-${toolId}`,
      toolId,
      modelId: spec.defaultModel,
      ownedBy: `prompt-${toolId}`,
      displayName: toolId,
    };
  }

  async detectAvailable(): Promise<ToolId[]> {
    const available: ToolId[] = [];
    for (const [id, spec] of this.specs) {
      const bin = spec.command[0];
      if (!bin) continue;
      if (bin.includes("/") || bin.endsWith(".mjs") || bin.endsWith(".js")) {
        available.push(id);
        continue;
      }
      if (await isCommandAvailable(bin)) available.push(id);
    }
    return available;
  }
}

function toSpec(toolId: string, cfg: import("../types.ts").ToolConfig): ToolSpec {
  return {
    toolId,
    command: [...(cfg.command ?? [])],
    promptMode: cfg.promptMode ?? "arg",
    ...(cfg.promptFlag !== undefined ? { promptFlag: cfg.promptFlag } : {}),
    stdinMode: cfg.stdinMode ?? "auto",
    forcePromptChannel: Boolean(cfg.forcePromptChannel),
    ...(cfg.stdinPromptArg !== undefined ? { stdinPromptArg: cfg.stdinPromptArg } : {}),
    ...(cfg.modelFlag !== undefined ? { modelFlag: cfg.modelFlag } : {}),
    trustedArgs: [...(cfg.trustedArgs ?? [])],
    extraArgs: [...(cfg.extraArgs ?? [])],
    env: { ...(cfg.env ?? {}) },
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
    ...(cfg.description !== undefined ? { description: cfg.description } : {}),
    ...(cfg.defaultModel !== undefined ? { defaultModel: cfg.defaultModel } : {}),
  };
}
