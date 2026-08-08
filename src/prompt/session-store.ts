import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SessionRole = "user" | "assistant" | "system";

export interface SessionTurn {
  role: SessionRole;
  content: string;
  at: number;
}

export interface SessionRecord {
  key: string;
  toolId: string;
  cwd: string;
  turns: SessionTurn[];
  createdAt: number;
  lastUsedAt: number;
}

export interface SessionStoreOptions {
  ttlMs: number;
  maxSessions: number;
  maxTurns: number;
  maxChars: number;
  /** Directory for hybrid disk snapshots; null disables persistence. */
  persistDir?: string | null;
  /** Debounce interval for dirty flushes (ms). Default 1000. */
  flushIntervalMs?: number;
  /** Injectable clock for tests */
  now?: () => number;
  /** Injectable fs for tests */
  fs?: SessionStoreFs;
}

export interface SessionStoreFs {
  mkdir: typeof mkdir;
  readdir: typeof readdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  rm: typeof rm;
}

const defaultFs: SessionStoreFs = { mkdir, readdir, readFile, writeFile, rename, rm };

/**
 * Hybrid transcript store: memory is source of truth; optional async file snapshots.
 * Does not hold CLI processes — each completion still spawns fresh.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dirty = new Set<string>();
  private readonly now: () => number;
  private readonly fs: SessionStoreFs;
  private readonly persistDir: string | null;
  private readonly flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: SessionStoreOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.fs = opts.fs ?? defaultFs;
    this.persistDir = opts.persistDir?.trim() ? opts.persistDir.trim() : null;
    this.flushIntervalMs = Math.max(50, opts.flushIntervalMs ?? 1000);
    if (this.persistDir) {
      this.flushTimer = setInterval(() => {
        void this.flushDirty();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  get size(): number {
    this.evictExpired();
    return this.sessions.size;
  }

  get persistenceEnabled(): boolean {
    return Boolean(this.persistDir);
  }

  /** Load non-expired snapshots from disk into memory. */
  async init(): Promise<number> {
    if (!this.persistDir) return 0;
    await this.fs.mkdir(this.persistDir, { recursive: true });
    const files = await this.listSessionFiles(this.persistDir);
    let loaded = 0;
    const t = this.now();
    for (const filePath of files) {
      try {
        const raw = await this.fs.readFile(filePath, "utf8");
        const rec = parseSessionRecord(JSON.parse(raw));
        if (!rec) {
          await this.fs.rm(filePath, { force: true });
          continue;
        }
        if (t - rec.lastUsedAt > this.opts.ttlMs) {
          await this.fs.rm(filePath, { force: true });
          continue;
        }
        this.trim(rec);
        this.sessions.set(rec.key, rec);
        loaded++;
      } catch {
        // skip unreadable
      }
    }
    this.ensureCapacity();
    return loaded;
  }

  get(key: string): SessionRecord | undefined {
    this.evictExpired();
    const s = this.sessions.get(key);
    if (!s) return undefined;
    s.lastUsedAt = this.now();
    // touch is hot-path; mark dirty so lastUsedAt can persist eventually
    this.markDirty(key);
    return s;
  }

  /** Ensure a session shell exists and return it. */
  touch(key: string, meta: { toolId: string; cwd: string }): SessionRecord {
    this.evictExpired();
    let s = this.sessions.get(key);
    const t = this.now();
    if (!s) {
      this.ensureCapacity();
      s = {
        key,
        toolId: meta.toolId,
        cwd: meta.cwd,
        turns: [],
        createdAt: t,
        lastUsedAt: t,
      };
      this.sessions.set(key, s);
      this.markDirty(key);
      return s;
    }
    s.toolId = meta.toolId;
    s.cwd = meta.cwd;
    s.lastUsedAt = t;
    this.markDirty(key);
    return s;
  }

  append(
    key: string,
    meta: { toolId: string; cwd: string },
    turns: Array<{ role: SessionRole; content: string }>,
  ): SessionRecord {
    const s = this.touch(key, meta);
    const t = this.now();
    for (const turn of turns) {
      const content = turn.content.trim();
      if (!content) continue;
      s.turns.push({ role: turn.role, content, at: t });
    }
    this.trim(s);
    s.lastUsedAt = t;
    this.markDirty(key);
    return s;
  }

  reset(key: string): void {
    this.sessions.delete(key);
    this.dirty.delete(key);
    if (this.persistDir) {
      void this.removeFile(key);
    }
  }

  clear(): void {
    const keys = [...this.sessions.keys()];
    this.sessions.clear();
    this.dirty.clear();
    if (this.persistDir) {
      for (const key of keys) void this.removeFile(key);
    }
  }

  /** Flush dirty sessions now (awaitable). */
  async flush(): Promise<void> {
    await this.flushDirty();
  }

  /** Stop background flusher and flush remaining dirty sessions. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushDirty();
  }

  private markDirty(key: string): void {
    if (!this.persistDir || this.closed) return;
    this.dirty.add(key);
  }

  private async flushDirty(): Promise<void> {
    if (!this.persistDir || this.dirty.size === 0) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const dir = this.persistDir;
    if (!dir) return;
    await this.fs.mkdir(dir, { recursive: true });
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const rec = this.sessions.get(key);
      if (!rec) {
        await this.removeFile(key);
        continue;
      }
      // clone snapshot for stable JSON
      const snapshot: SessionRecord = {
        key: rec.key,
        toolId: rec.toolId,
        cwd: rec.cwd,
        turns: rec.turns.map((t) => ({ ...t })),
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt,
      };
      await this.writeAtomic(key, snapshot);
    }
  }

  private filePathFor(key: string): string {
    const dir = this.persistDir!;
    const hash = createHash("sha256").update(key).digest("hex");
    // shard: ab/cd/<fullhash>.json
    return join(dir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json`);
  }

  private async writeAtomic(key: string, rec: SessionRecord): Promise<void> {
    const target = this.filePathFor(key);
    const tmp = `${target}.${process.pid}.${this.now()}.tmp`;
    await this.fs.mkdir(dirname(target), { recursive: true });
    const body = JSON.stringify(rec, null, 0);
    await this.fs.writeFile(tmp, body, "utf8");
    await this.fs.rename(tmp, target);
  }

  private async removeFile(key: string): Promise<void> {
    if (!this.persistDir) return;
    try {
      await this.fs.rm(this.filePathFor(key), { force: true });
    } catch {
      // ignore
    }
  }

  private async listSessionFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      let entries: string[];
      try {
        entries = await this.fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const p = join(dir, name);
        if (name.endsWith(".json") && depth >= 2) {
          out.push(p);
          continue;
        }
        if (depth < 3 && !name.includes(".")) {
          await walk(p, depth + 1);
        }
      }
    };
    await walk(root, 0);
    return out;
  }

  private trim(s: SessionRecord): void {
    const { maxTurns, maxChars } = this.opts;
    while (s.turns.length > maxTurns) {
      s.turns.shift();
    }
    let total = s.turns.reduce((n, x) => n + x.content.length, 0);
    while (s.turns.length > 1 && total > maxChars) {
      const removed = s.turns.shift();
      total -= removed?.content.length ?? 0;
    }
  }

  private evictExpired(): void {
    const t = this.now();
    const ttl = this.opts.ttlMs;
    for (const [k, s] of this.sessions) {
      if (t - s.lastUsedAt > ttl) {
        this.sessions.delete(k);
        this.dirty.delete(k);
        if (this.persistDir) void this.removeFile(k);
      }
    }
  }

  private ensureCapacity(): void {
    while (this.sessions.size >= this.opts.maxSessions) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastUsedAt < oldestAt) {
          oldestAt = s.lastUsedAt;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
      this.dirty.delete(oldestKey);
      if (this.persistDir) void this.removeFile(oldestKey);
    }
  }
}

function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.key !== "string" || !o.key) return null;
  if (typeof o.toolId !== "string") return null;
  if (typeof o.cwd !== "string") return null;
  if (!Array.isArray(o.turns)) return null;
  const turns: SessionTurn[] = [];
  for (const item of o.turns) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const role = t.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    if (typeof t.content !== "string") continue;
    turns.push({
      role,
      content: t.content,
      at: typeof t.at === "number" ? t.at : 0,
    });
  }
  return {
    key: o.key,
    toolId: o.toolId,
    cwd: o.cwd,
    turns,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
    lastUsedAt: typeof o.lastUsedAt === "number" ? o.lastUsedAt : 0,
  };
}

/** Build affinity key from OpenAI request fields. */
export function resolveSessionKey(opts: {
  sessionId?: string;
  user?: string;
  toolId: string;
  cwd: string;
}): string | undefined {
  const sid = opts.sessionId?.trim();
  if (sid) return `sid:${sid}`;
  const user = opts.user?.trim();
  if (user) return `user:${user}:${opts.toolId}:${opts.cwd}`;
  return undefined;
}
