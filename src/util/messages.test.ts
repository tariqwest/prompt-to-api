import { describe, expect, test } from "bun:test";
import { messagesToPrompt, resolveCwd, contentToText } from "./messages.ts";

describe("messages", () => {
  test("contentToText string and parts", () => {
    expect(contentToText("hi")).toBe("hi");
    expect(contentToText([{ type: "text", text: "a" }, { text: "b" }])).toBe("a\nb");
  });

  test("messagesToPrompt roles", () => {
    const p = messagesToPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(p).toContain("System: be brief");
    expect(p).toContain("User: hello");
    expect(p).toContain("Assistant: hi");
  });

  test("resolveCwd explicit", () => {
    const cwd = resolveCwd({ explicit: "/tmp", fallback: "/var" });
    expect(cwd).toBe("/tmp");
  });
});
