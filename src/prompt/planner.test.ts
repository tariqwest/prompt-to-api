import { describe, expect, test } from "bun:test";
import { planInvocation } from "./planner.ts";
import type { ToolSpec } from "../types.ts";

function spec(partial: Partial<ToolSpec> & Pick<ToolSpec, "toolId" | "command" | "promptMode">): ToolSpec {
  return {
    stdinMode: "none",
    forcePromptChannel: true,
    trustedArgs: [],
    extraArgs: [],
    env: {},
    ...partial,
  };
}

describe("planInvocation", () => {
  test("claude -p arg mode with trusted args", () => {
    const plan = planInvocation({
      spec: spec({
        toolId: "claude",
        command: ["claude", "-p"],
        promptMode: "arg",
        trustedArgs: ["--dangerously-skip-permissions"],
        modelFlag: "--model",
      }),
      prompt: "hello",
      cwd: "/tmp",
      trusted: true,
      modelId: "sonnet",
    });
    expect(plan.argv).toEqual([
      "claude",
      "-p",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
      "hello",
    ]);
    expect(plan.stdin).toBeNull();
  });

  test("goose flag mode -t", () => {
    const plan = planInvocation({
      spec: spec({
        toolId: "goose",
        command: ["goose", "run", "-q"],
        promptMode: "flag",
        promptFlag: "-t",
        forcePromptChannel: false,
      }),
      prompt: "summarize",
      cwd: "/tmp",
      trusted: false,
    });
    expect(plan.argv).toEqual(["goose", "run", "-q", "-t", "summarize"]);
  });

  test("copilot -p -s trusted", () => {
    const plan = planInvocation({
      spec: spec({
        toolId: "copilot",
        command: ["copilot"],
        promptMode: "flag",
        promptFlag: "-p",
        trustedArgs: ["--allow-all"],
        extraArgs: ["-s"],
      }),
      prompt: "ping",
      cwd: "/tmp",
      trusted: true,
    });
    expect(plan.argv).toEqual(["copilot", "--allow-all", "-s", "-p", "ping"]);
  });

  test("oz --prompt flag", () => {
    const plan = planInvocation({
      spec: spec({
        toolId: "oz",
        command: ["oz", "agent", "run"],
        promptMode: "flag",
        promptFlag: "--prompt",
      }),
      prompt: "hi",
      cwd: "/tmp",
      trusted: true,
    });
    expect(plan.argv).toEqual(["oz", "agent", "run", "--prompt", "hi"]);
  });
});
