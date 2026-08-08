export type PromptMode = "arg" | "stdin" | "flag" | "combined" | "none";
export type StdinMode = "prompt" | "context" | "none" | "auto";

export type ToolId = string;

export interface ConcurrencyConfig {
  maxGlobal: number;
  maxPerAgent: number;
}

/** In-memory transcript session store (not warm CLI processes). */
export interface SessionConfig {
  enabled: boolean;
  /** Idle eviction TTL */
  ttlMs: number;
  maxSessions: number;
  /** Max turns retained per session (user+assistant pairs count as 2) */
  maxTurns: number;
  /** Max total characters across retained turn contents */
  maxChars: number;
  /**
   * Optional directory for hybrid disk snapshots.
   * Memory remains source of truth; dirty sessions flush asynchronously.
   * null/empty disables persistence.
   */
  persistDir: string | null;
  /** Debounced flush interval for dirty sessions (ms). */
  flushIntervalMs: number;
}

export type SessionMode = "auto" | "off" | "delta" | "full";

export interface ToolConfig {
  enabled: boolean;
  /** Binary + fixed headless argv prefix, e.g. ["claude","-p"] or ["codex","exec"] */
  command: string[];
  promptMode: PromptMode;
  promptFlag?: string;
  stdinMode: StdinMode;
  forcePromptChannel?: boolean;
  stdinPromptArg?: string;
  /** Flag that accepts context from stdin (e.g. goose -i -). */
  contextFlag?: string;
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
  session: SessionConfig;
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
  contextFlag?: string;
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
