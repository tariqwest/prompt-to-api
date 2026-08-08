import { describe, expect, test } from "bun:test";
import { Registry } from "./registry.ts";
import { builtinTools } from "./catalog.ts";
import type { AppConfig } from "../types.ts";

function cfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8788,
    authToken: null,
    defaultCwd: "/tmp",
    trusted: true,
    timeoutMs: 1000,
    concurrency: { maxGlobal: 2, maxPerAgent: 1 },
    tools: builtinTools,
    ...over,
  };
}

describe("Registry", () => {
  test("resolve prompt-claude and alias", () => {
    const r = new Registry(cfg());
    expect(r.resolveModel("prompt-claude").toolId).toBe("claude");
    expect(r.resolveModel("prompt-claude-code").toolId).toBe("claude");
    expect(r.resolveModel("prompt-claude/sonnet").modelId).toBe("sonnet");
    expect(r.resolveModel("prompt-antigravity").toolId).toBe("agy");
  });

  test("unknown model throws", () => {
    const r = new Registry(cfg());
    expect(() => r.resolveModel("prompt-nope")).toThrow();
  });

  test("disabled tools omitted", () => {
    const tools = { ...builtinTools, claude: { ...builtinTools.claude!, enabled: false } };
    const r = new Registry(cfg({ tools }));
    expect(r.listToolIds()).not.toContain("claude");
  });
});
