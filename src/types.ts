export type PromptMode = "arg" | "stdin" | "flag" | "combined" | "none";
export type StdinMode = "prompt" | "context" | "none" | "auto";

export type ToolId = string;

export interface ConcurrencyConfig {
  maxGlobal: number;
  maxPerAgent: number;
}

export interface ToolConfig {
  enabled: boolean;
  /** Binary + fixed headless argv prefix, e.g. ["claude","-p"] or ["codex","exec"] */
  command: string[];
  promptMode: PromptMode;
  promptFlag?: string;
  stdinMode: StdinMode;
  forcePromptChannel?: boolean;
  stdinPromptArg?: string;
  modelFlag?: string;
  trustedArgs?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
  aliases?: string[];
  description?: string;
  defaultModel?: string;
}

export interface AppConfig {
  host: string;
  port: number;
  authToken: string | null;
  defaultCwd: string | null;
  /** Default permission bypass (promptpipe trusted mode). */
  trusted: boolean;
  timeoutMs: number;
  concurrency: ConcurrencyConfig;
  tools: Record<ToolId, ToolConfig>;
}

export interface ToolSpec {
  toolId: ToolId;
  command: string[];
  promptMode: PromptMode;
  promptFlag?: string;
  stdinMode: StdinMode;
  forcePromptChannel: boolean;
  stdinPromptArg?: string;
  modelFlag?: string;
  trustedArgs: string[];
  extraArgs: string[];
  env: Record<string, string>;
  cwd?: string;
  description?: string;
  defaultModel?: string;
}

export interface ResolvedModel {
  /** OpenAI model id, e.g. prompt-claude/sonnet */
  id: string;
  toolId: ToolId;
  modelId?: string;
  ownedBy: string;
  displayName: string;
}

export interface CatalogModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  metadata?: {
    toolId: string;
    modelId?: string;
    name?: string;
    description?: string;
  };
}

export interface PlannedInvocation {
  argv: string[];
  stdin: string | null;
  cwd: string;
  env: Record<string, string>;
  toolId: ToolId;
  modelId?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
