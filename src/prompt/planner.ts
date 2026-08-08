import type { PlannedInvocation, ToolSpec } from "../types.ts";

export interface PlanOptions {
  spec: ToolSpec;
  prompt: string;
  cwd: string;
  trusted: boolean;
  modelId?: string;
  /** Optional extra context / stdin payload when stdinMode allows */
  context?: string;
  passThroughArgs?: string[];
}

/**
 * Build argv + stdin for a single-prompt CLI invocation.
 * Mirrors promptpipe `planCommand` headless run semantics:
 * - prompt channel first (arg/flag/stdin/combined/none)
 * - then modelFlag + model
 * - then trailing trustedArgs + extraArgs + pass-through
 */
export function planInvocation(opts: PlanOptions): PlannedInvocation {
  const { spec, prompt, cwd, trusted, modelId, context, passThroughArgs } = opts;
  const cmd = [...spec.command];

  const text = prompt.trim() ? prompt.trimEnd() : "";
  const ctxRaw = typeof context === "string" && context.length > 0 ? context : undefined;
  const hasPrompt = text.length > 0;
  const hasStdin = ctxRaw != null;

  let stdinMode = spec.stdinMode ?? "auto";
  if (stdinMode === "auto") {
    if (!hasStdin) stdinMode = "none";
    else if (!hasPrompt) stdinMode = "prompt";
    else stdinMode = "context";
  }

  let finalStdin: string | null = null;

  const pushPrompt = (value: string) => {
    switch (spec.promptMode) {
      case "arg":
        cmd.push(value);
        break;
      case "flag": {
        const flag = spec.promptFlag;
        if (!flag) {
          throw new Error(
            `Tool '${spec.toolId}' promptMode=flag requires promptFlag (e.g. -p or -t)`,
          );
        }
        cmd.push(flag, value);
        break;
      }
      case "stdin":
      case "combined":
        finalStdin =
          finalStdin && finalStdin.length > 0 ? `${value}\n\n${finalStdin}` : value;
        break;
      case "none":
        break;
      default:
        cmd.push(value);
    }
  };

  const promptValue = hasPrompt ? text : "Hello";

  // stdin only (context without prompt text — rare for API)
  if (hasStdin && !hasPrompt) {
    if (stdinMode === "none") {
      pushPrompt("Hello");
    } else if (spec.stdinPromptArg) {
      cmd.push(spec.stdinPromptArg);
      finalStdin = ctxRaw!;
    } else if (spec.contextFlag && spec.promptMode === "flag") {
      cmd.push(spec.contextFlag, "-");
      finalStdin = ctxRaw!;
    } else if (spec.promptMode === "stdin" || spec.promptMode === "combined") {
      finalStdin = ctxRaw!;
    } else if (spec.forcePromptChannel) {
      pushPrompt(ctxRaw!);
    } else {
      finalStdin = ctxRaw!;
    }
  }

  // prompt only
  if (hasPrompt && !hasStdin) {
    pushPrompt(promptValue);
  }

  // neither — force a minimal prompt on the channel
  if (!hasPrompt && !hasStdin) {
    if (spec.promptMode !== "none") {
      pushPrompt("Hello");
    }
  }

  // prompt + stdin context
  if (hasPrompt && hasStdin) {
    if (stdinMode === "none") {
      pushPrompt(promptValue);
    } else if (stdinMode === "prompt") {
      const merged = `${promptValue}\n\n${ctxRaw}`;
      if (spec.stdinPromptArg) {
        cmd.push(spec.stdinPromptArg);
        finalStdin = merged;
      } else if (spec.forcePromptChannel) {
        pushPrompt(merged);
      } else {
        finalStdin = merged;
      }
    } else {
      // context
      pushPrompt(promptValue);
      if (spec.contextFlag) {
        cmd.push(spec.contextFlag, "-");
        finalStdin = ctxRaw!;
      } else {
        finalStdin = ctxRaw!;
      }
    }
  }

  if (modelId && modelId.trim()) {
    const modelFlag = spec.modelFlag?.trim();
    if (!modelFlag) {
      throw new Error(
        `Model '${modelId}' requested but tool '${spec.toolId}' has no modelFlag configured`,
      );
    }
    cmd.push(modelFlag, modelId.trim());
  }

  const trailing: string[] = [];
  if (trusted && spec.trustedArgs.length) trailing.push(...spec.trustedArgs);
  if (spec.extraArgs.length) trailing.push(...spec.extraArgs);
  if (passThroughArgs?.length) trailing.push(...passThroughArgs);
  if (trailing.length) cmd.push(...trailing);

  return {
    argv: cmd,
    stdin: finalStdin,
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
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
