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
  /** Injectable clock for tests */
  now?: () => number;
}

/**
 * In-memory transcript store for multi-turn prompt assembly.
 * Does not hold CLI processes — each completion still spawns fresh.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;

  constructor(private readonly opts: SessionStoreOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    this.evictExpired();
    return this.sessions.size;
  }

  get(key: string): SessionRecord | undefined {
    this.evictExpired();
    const s = this.sessions.get(key);
    if (!s) return undefined;
    s.lastUsedAt = this.now();
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
      return s;
    }
    s.toolId = meta.toolId;
    s.cwd = meta.cwd;
    s.lastUsedAt = t;
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
    return s;
  }

  reset(key: string): void {
    this.sessions.delete(key);
  }

  clear(): void {
    this.sessions.clear();
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
      if (t - s.lastUsedAt > ttl) this.sessions.delete(k);
    }
  }

  private ensureCapacity(): void {
    if (this.sessions.size < this.opts.maxSessions) return;
    // Evict least-recently used
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, s] of this.sessions) {
      if (s.lastUsedAt < oldestAt) {
        oldestAt = s.lastUsedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) this.sessions.delete(oldestKey);
  }
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
