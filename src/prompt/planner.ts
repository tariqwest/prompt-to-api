import type { PlannedInvocation, ToolSpec } from "../types.ts";

export interface PlanOptions {
  spec: ToolSpec;
  prompt: string;
  cwd: string;
  trusted: boolean;
  modelId?: string;
  /** Optional extra context piped as stdin when stdinMode allows */
  context?: string;
  passThroughArgs?: string[];
}

/**
 * Build argv + stdin for a single-prompt CLI invocation.
 * Mirrors promptpipe headless run planning (simplified).
 */
export function planInvocation(opts: PlanOptions): PlannedInvocation {
  const { spec, prompt, cwd, trusted, modelId, context, passThroughArgs } = opts;
  const argv = [...spec.command];

  if (trusted && spec.trustedArgs.length) {
    argv.push(...spec.trustedArgs);
  }
  if (spec.extraArgs.length) {
    argv.push(...spec.extraArgs);
  }
  if (modelId && spec.modelFlag) {
    argv.push(spec.modelFlag, modelId);
  }
  if (passThroughArgs?.length) {
    argv.push(...passThroughArgs);
  }

  let stdin: string | null = null;
  const text = prompt.trim();
  const ctx = (context ?? "").trim();

  switch (spec.promptMode) {
    case "flag": {
      const flag = spec.promptFlag ?? "--prompt";
      argv.push(flag, text || "Hello");
      if (ctx && spec.stdinMode !== "none") stdin = ctx;
      break;
    }
    case "stdin": {
      stdin = text || "Hello";
      if (spec.stdinPromptArg) argv.push(spec.stdinPromptArg);
      break;
    }
    case "combined": {
      // prompt as arg; context on stdin when present
      if (text) argv.push(text);
      if (ctx) stdin = ctx;
      else if (!text) stdin = "Hello";
      break;
    }
    case "none": {
      if (ctx && spec.stdinMode !== "none") stdin = ctx;
      break;
    }
    case "arg":
    default: {
      // forcePromptChannel tools always put prompt on argv even if empty-ish
      if (text || spec.forcePromptChannel) {
        argv.push(text || "Hello");
      } else if (spec.stdinMode === "auto" || spec.stdinMode === "prompt") {
        stdin = "Hello";
        if (spec.stdinPromptArg) argv.push(spec.stdinPromptArg);
      } else {
        argv.push("Hello");
      }
      if (ctx && spec.stdinMode !== "none") {
        // Prefer piping context when both exist (promptpipe auto)
        if (text || spec.forcePromptChannel) stdin = ctx;
        else stdin = [ctx, text].filter(Boolean).join("\n\n") || "Hello";
      }
      break;
    }
  }

  return {
    argv,
    stdin,
    cwd,
    env: { ...spec.env },
    toolId: spec.toolId,
    modelId,
  };
}

export function formatPlannedCommand(plan: PlannedInvocation): string {
  const parts = plan.argv.map(shellQuote);
  const base = parts.join(" ");
  if (plan.stdin != null) {
    return `printf %s ${shellQuote(plan.stdin)} | ${base}`;
  }
  return base;
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
