import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, resolveSessionKey } from "./session-store.ts";
import { resolvePromptText } from "../server.ts";
import { buildSessionPrompt, clientSentFullHistory } from "../util/messages.ts";

describe("resolveSessionKey", () => {
  test("prefers session_id", () => {
    expect(
      resolveSessionKey({ sessionId: "abc", user: "u", toolId: "claude", cwd: "/tmp" }),
    ).toBe("sid:abc");
  });
  test("falls back to user+tool+cwd", () => {
    expect(resolveSessionKey({ user: "u", toolId: "claude", cwd: "/tmp" })).toBe(
      "user:u:claude:/tmp",
    );
  });
  test("undefined without affinity", () => {
    expect(resolveSessionKey({ toolId: "claude", cwd: "/tmp" })).toBeUndefined();
  });
});

describe("SessionStore", () => {
  test("append trim and get", () => {
    const store = new SessionStore({
      ttlMs: 60_000,
      maxSessions: 10,
      maxTurns: 4,
      maxChars: 10_000,
    });
    store.append("sid:1", { toolId: "claude", cwd: "/tmp" }, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    store.append("sid:1", { toolId: "claude", cwd: "/tmp" }, [
      { role: "user", content: "again" },
      { role: "assistant", content: "ok" },
    ]);
    store.append("sid:1", { toolId: "claude", cwd: "/tmp" }, [
      { role: "user", content: "third" },
      { role: "assistant", content: "fine" },
    ]);
    const s = store.get("sid:1")!;
    expect(s.turns.length).toBe(4); // maxTurns
    expect(s.turns[0]?.content).toBe("again");
  });

  test("ttl eviction", () => {
    let now = 1_000;
    const store = new SessionStore({
      ttlMs: 100,
      maxSessions: 10,
      maxTurns: 10,
      maxChars: 10_000,
      now: () => now,
    });
    store.append("sid:x", { toolId: "t", cwd: "/" }, [{ role: "user", content: "a" }]);
    now = 1_050;
    expect(store.get("sid:x")).toBeDefined();
    now = 1_200;
    expect(store.get("sid:x")).toBeUndefined();
  });

  test("maxSessions LRU", () => {
    let now = 0;
    const store = new SessionStore({
      ttlMs: 60_000,
      maxSessions: 2,
      maxTurns: 10,
      maxChars: 10_000,
      now: () => ++now,
    });
    store.append("a", { toolId: "t", cwd: "/" }, [{ role: "user", content: "1" }]);
    store.append("b", { toolId: "t", cwd: "/" }, [{ role: "user", content: "2" }]);
    store.get("a"); // touch a as more recent
    store.append("c", { toolId: "t", cwd: "/" }, [{ role: "user", content: "3" }]);
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBeDefined();
    expect(store.get("c")).toBeDefined();
  });
});

describe("buildSessionPrompt", () => {
  test("delta uses tail + latest user", () => {
    const p = buildSessionPrompt({
      mode: "delta",
      storeTurns: [
        { role: "user", content: "one", at: 1 },
        { role: "assistant", content: "1", at: 2 },
        { role: "user", content: "two", at: 3 },
        { role: "assistant", content: "2", at: 4 },
      ],
      messages: [{ role: "user", content: "three" }],
      maxTailTurns: 2,
    });
    expect(p).toContain("User: two");
    expect(p).toContain("Assistant: 2");
    expect(p).toContain("User: three");
    expect(p).not.toContain("User: one");
  });
});

describe("clientSentFullHistory", () => {
  test("detects multi-turn client payload", () => {
    expect(clientSentFullHistory([{ role: "user", content: "hi" }])).toBe(false);
    expect(
      clientSentFullHistory([
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "more" },
      ]),
    ).toBe(true);
  });
});

describe("resolvePromptText", () => {
  test("auto + full client history passthrough", () => {
    const sessions = new SessionStore({
      ttlMs: 60_000,
      maxSessions: 10,
      maxTurns: 20,
      maxChars: 10_000,
    });
    sessions.append("sid:1", { toolId: "claude", cwd: "/tmp" }, [
      { role: "user", content: "old" },
      { role: "assistant", content: "reply" },
    ]);
    const r = resolvePromptText({
      sessionEnabled: true,
      sessionKey: "sid:1",
      mode: "auto",
      reset: false,
      sessions,
      toolId: "claude",
      cwd: "/tmp",
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "new" },
      ],
    });
    expect(r.usedStore).toBe(false);
    expect(r.promptText).toContain("User: new");
    expect(r.promptText).toContain("Assistant: reply");
  });

  test("delta uses store when client sends only latest", () => {
    const sessions = new SessionStore({
      ttlMs: 60_000,
      maxSessions: 10,
      maxTurns: 20,
      maxChars: 10_000,
    });
    sessions.append("sid:2", { toolId: "claude", cwd: "/tmp" }, [
      { role: "user", content: "old" },
      { role: "assistant", content: "reply" },
    ]);
    const r = resolvePromptText({
      sessionEnabled: true,
      sessionKey: "sid:2",
      mode: "auto",
      reset: false,
      sessions,
      toolId: "claude",
      cwd: "/tmp",
      messages: [{ role: "user", content: "follow up" }],
    });
    expect(r.usedStore).toBe(true);
    expect(r.promptText).toContain("User: old");
    expect(r.promptText).toContain("Assistant: reply");
    expect(r.promptText).toContain("User: follow up");
  });
});



describe("SessionStore hybrid disk", () => {
  test("flush and reload across instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pta-sess-"));
    try {
      const a = new SessionStore({
        ttlMs: 60_000,
        maxSessions: 10,
        maxTurns: 20,
        maxChars: 10_000,
        persistDir: dir,
        flushIntervalMs: 60_000,
      });
      a.append("sid:disk", { toolId: "claude", cwd: "/tmp" }, [
        { role: "user", content: "hello disk" },
        { role: "assistant", content: "saved" },
      ]);
      await a.flush();
      await a.close();

      const b = new SessionStore({
        ttlMs: 60_000,
        maxSessions: 10,
        maxTurns: 20,
        maxChars: 10_000,
        persistDir: dir,
        flushIntervalMs: 60_000,
      });
      const n = await b.init();
      expect(n).toBe(1);
      const rec = b.get("sid:disk");
      expect(rec?.turns.map((t) => t.content)).toEqual(["hello disk", "saved"]);
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reset removes snapshot file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pta-sess-"));
    try {
      const a = new SessionStore({
        ttlMs: 60_000,
        maxSessions: 10,
        maxTurns: 20,
        maxChars: 10_000,
        persistDir: dir,
        flushIntervalMs: 60_000,
      });
      a.append("sid:gone", { toolId: "t", cwd: "/" }, [{ role: "user", content: "x" }]);
      await a.flush();
      a.reset("sid:gone");
      await a.flush();
      await a.close();

      const b = new SessionStore({
        ttlMs: 60_000,
        maxSessions: 10,
        maxTurns: 20,
        maxChars: 10_000,
        persistDir: dir,
        flushIntervalMs: 60_000,
      });
      expect(await b.init()).toBe(0);
      expect(b.get("sid:gone")).toBeUndefined();
      await b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
