import { describe, expect, test } from "bun:test";
import { planInvocation } from "./planner.ts";
import { builtinTools } from "../adapters/catalog.ts";
import { Registry } from "../adapters/registry.ts";
import type { AppConfig, ToolSpec } from "../types.ts";

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

function loadSpecs(): Map<string, ToolSpec> {
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 8788,
    authToken: null,
    defaultCwd: "/tmp",
    trusted: true,
    timeoutMs: 60_000,
    concurrency: { maxGlobal: 8, maxPerAgent: 2 },
    tools: builtinTools,
  };
  const reg = new Registry(config);
  const m = new Map<string, ToolSpec>();
  for (const id of reg.listToolIds()) {
    m.set(id, reg.getSpec(id)!);
  }
  return m;
}

describe("planInvocation", () => {
  test("claude -p arg mode with trailing trusted + model", () => {
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
      "hello",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
    ]);
    expect(plan.stdin).toBeNull();
  });

  test("goose flag mode -t then model then trailing", () => {
    const plan = planInvocation({
      spec: spec({
        toolId: "goose",
        command: ["goose", "run", "-q"],
        promptMode: "flag",
        promptFlag: "-t",
        forcePromptChannel: false,
        modelFlag: "--model",
        contextFlag: "-i",
      }),
      prompt: "summarize",
      cwd: "/tmp",
      trusted: false,
      modelId: "gpt",
    });
    expect(plan.argv).toEqual(["goose", "run", "-q", "-t", "summarize", "--model", "gpt"]);
  });

  test("goose pipes context via -i -", () => {
    const plan = planInvocation({
      spec: spec({
        toolId: "goose",
        command: ["goose", "run", "-q"],
        promptMode: "flag",
        promptFlag: "-t",
        stdinMode: "auto",
        contextFlag: "-i",
        forcePromptChannel: false,
      }),
      prompt: "review",
      context: "diff here",
      cwd: "/tmp",
      trusted: false,
    });
    expect(plan.argv).toEqual(["goose", "run", "-q", "-t", "review", "-i", "-"]);
    expect(plan.stdin).toBe("diff here");
  });

  test("copilot -p prompt then trusted/extra", () => {
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
    expect(plan.argv).toEqual(["copilot", "-p", "ping", "--allow-all", "-s"]);
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

  test("untrusted skips trustedArgs", () => {
    const plan = planInvocation({
      spec: spec({
        toolId: "claude",
        command: ["claude", "-p"],
        promptMode: "arg",
        trustedArgs: ["--dangerously-skip-permissions"],
      }),
      prompt: "x",
      cwd: "/tmp",
      trusted: false,
    });
    expect(plan.argv).toEqual(["claude", "-p", "x"]);
  });

  test("catalog matrix: every builtin plans without throw", () => {
    const specs = loadSpecs();
    expect(specs.size).toBeGreaterThan(10);
    for (const [id, s] of specs) {
      const plan = planInvocation({
        spec: s,
        prompt: "ping",
        cwd: "/tmp",
        trusted: true,
        modelId: s.modelFlag ? "test-model" : undefined,
      });
      expect(plan.argv[0], id).toBeTruthy();
      expect(plan.argv.join(" "), id).toContain("ping");
      if (s.modelFlag) {
        expect(plan.argv, id).toContain(s.modelFlag);
        expect(plan.argv, id).toContain("test-model");
      }
      if (s.trustedArgs.length) {
        for (const t of s.trustedArgs) {
          expect(plan.argv, id).toContain(t);
        }
      }
    }
  });
});
