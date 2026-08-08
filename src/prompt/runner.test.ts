import { describe, expect, test } from "bun:test";
import { ConcurrencyGate, runPlanned } from "./runner.ts";

describe("ConcurrencyGate", () => {
  test("limits global concurrency", async () => {
    const gate = new ConcurrencyGate(1, 2);
    const order: string[] = [];
    const a = gate.acquire("t1").then(async (release) => {
      order.push("a-start");
      await Bun.sleep(30);
      order.push("a-end");
      release();
    });
    const b = gate.acquire("t2").then(async (release) => {
      order.push("b-start");
      release();
    });
    await Promise.all([a, b]);
    expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("a-end"));
    expect(order.indexOf("b-start")).toBeGreaterThan(order.indexOf("a-start"));
  });
});

describe("runPlanned", () => {
  test("captures stdout from echo", async () => {
    const result = await runPlanned({
      plan: {
        argv: ["printf", "%s", "hello-out"],
        stdin: null,
        cwd: process.cwd(),
        env: {},
        toolId: "echo",
      },
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-out");
  });
});
