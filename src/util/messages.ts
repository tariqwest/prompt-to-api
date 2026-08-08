import { dirname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { SessionTurn } from "../prompt/session-store.ts";

export interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
}

export function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? homedir();
  if (p.startsWith("~/")) return `${process.env.HOME ?? homedir()}/${p.slice(2)}`;
  return p;
}

export function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
  }
  return String(content);
}

/** Flatten OpenAI chat messages into one single-prompt string. */
export function messagesToPrompt(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = (m.role ?? "user").toLowerCase();
    const text = contentToText(m.content).trim();
    if (!text) continue;
    if (role === "system" || role === "developer") {
      lines.push(`System: ${text}`);
    } else if (role === "assistant") {
      lines.push(`Assistant: ${text}`);
    } else if (role === "tool" || role === "function") {
      lines.push(`Tool: ${text}`);
    } else {
      lines.push(`User: ${text}`);
    }
  }
  return lines.join("\n\n").trim();
}

export function latestUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const role = (m.role ?? "user").toLowerCase();
    if (role === "user") {
      return contentToText(m.content).trim();
    }
  }
  return "";
}

function extractPaths(text: string): string[] {
  const re = /(?:^|[\s"'`])(\/(?:[\w.-]+\/)*[\w.-]+|~\/(?:[\w.-]+\/)*[\w.-]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

export function resolveCwd(opts: {
  explicit?: string | null;
  messages?: ChatMessage[];
  fallback: string;
}): string {
  if (opts.explicit) {
    const p = expandHome(opts.explicit);
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        return st.isDirectory() ? p : dirname(p);
      }
    } catch {
      // ignore
    }
    return p;
  }

  const blob = (opts.messages ?? []).map((m) => contentToText(m.content)).join("\n");
  const paths = extractPaths(blob);
  for (const raw of paths) {
    const p = expandHome(raw);
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        const dir = st.isDirectory() ? p : dirname(p);
        if (existsSync(dir)) return dir;
      }
    } catch {
      // continue
    }
  }

  return opts.fallback;
}


/** True when the client likely already sent a multi-turn transcript. */
export function clientSentFullHistory(messages: ChatMessage[]): boolean {
  if (messages.length <= 1) return false;
  let users = 0;
  let assistants = 0;
  for (const m of messages) {
    const role = (m.role ?? "user").toLowerCase();
    if (role === "user") users++;
    else if (role === "assistant") assistants++;
  }
  return users >= 1 && assistants >= 1;
}

function turnsToPrompt(turns: SessionTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const text = t.content.trim();
    if (!text) continue;
    if (t.role === "system") lines.push(`System: ${text}`);
    else if (t.role === "assistant") lines.push(`Assistant: ${text}`);
    else lines.push(`User: ${text}`);
  }
  return lines.join("\n\n").trim();
}

/**
 * Assemble prompt for a session-backed request.
 * - full: store turns + optional latest user if not already last
 * - delta: tail of store + latest user message
 */
export function buildSessionPrompt(opts: {
  mode: "delta" | "full";
  storeTurns: SessionTurn[];
  messages: ChatMessage[];
  maxTailTurns?: number;
}): string {
  const latest = latestUserPrompt(opts.messages);
  const storePrompt = turnsToPrompt(opts.storeTurns);

  if (opts.mode === "full") {
    if (!latest) return storePrompt || messagesToPrompt(opts.messages) || "User: Hello";
    // Avoid duplicating if store already ends with same user turn
    const last = opts.storeTurns[opts.storeTurns.length - 1];
    if (last?.role === "user" && last.content.trim() === latest) {
      return storePrompt || `User: ${latest}`;
    }
    const base = storePrompt ? `${storePrompt}\n\nUser: ${latest}` : `User: ${latest}`;
    return base;
  }

  // delta
  const tailN = opts.maxTailTurns ?? 6;
  const tail = opts.storeTurns.slice(-tailN);
  const tailPrompt = turnsToPrompt(tail);
  if (!latest) return tailPrompt || "User: Hello";
  const last = tail[tail.length - 1];
  if (last?.role === "user" && last.content.trim() === latest) {
    return tailPrompt || `User: ${latest}`;
  }
  return tailPrompt ? `${tailPrompt}\n\nUser: ${latest}` : `User: ${latest}`;
}
