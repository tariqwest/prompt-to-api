import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppConfig, SessionMode } from "./types.ts";
import { Registry } from "./adapters/registry.ts";
import { ModelCatalog } from "./prompt/catalog.ts";
import { planInvocation, formatPlannedCommand } from "./prompt/planner.ts";
import { ConcurrencyGate, runPlanned } from "./prompt/runner.ts";
import { SessionStore, resolveSessionKey } from "./prompt/session-store.ts";
import {
  ChatCompletionsRequestSchema,
  completionId,
  openaiError,
  toSseChunk,
} from "./openai/schema.ts";
import {
  buildSessionPrompt,
  clientSentFullHistory,
  latestUserPrompt,
  messagesToPrompt,
  resolveCwd,
  type ChatMessage,
} from "./util/messages.ts";

export interface AppContext {
  config: AppConfig;
  registry: Registry;
  catalog: ModelCatalog;
  gate: ConcurrencyGate;
  sessions: SessionStore;
}

function parseSessionMode(raw: unknown, fallback: SessionMode = "auto"): SessionMode {
  const s = String(raw ?? fallback).toLowerCase();
  if (s === "off" || s === "delta" || s === "full" || s === "auto") return s;
  return fallback;
}

function sessionMeta(meta: Record<string, unknown>): {
  sessionId?: string;
  mode: SessionMode;
  reset: boolean;
} {
  const sessionId =
    (typeof meta.session_id === "string" && meta.session_id) ||
    (typeof meta.sessionId === "string" && meta.sessionId) ||
    undefined;
  const mode = parseSessionMode(meta.session_mode ?? meta.sessionMode ?? "auto");
  const reset = meta.reset_session === true || meta.resetSession === true;
  return { sessionId, mode, reset };
}

/** Choose prompt text using optional transcript store. */
export function resolvePromptText(opts: {
  sessionEnabled: boolean;
  sessionKey: string | undefined;
  mode: SessionMode;
  reset: boolean;
  sessions: SessionStore;
  toolId: string;
  cwd: string;
  messages: ChatMessage[];
}): {
  promptText: string;
  sessionKey?: string;
  usedStore: boolean;
  mode: SessionMode | "off";
} {
  const messages = opts.messages;
  const baseFallback = () => messagesToPrompt(messages) || "User: Hello";

  if (!opts.sessionEnabled || !opts.sessionKey || opts.mode === "off") {
    return { promptText: baseFallback(), mode: "off", usedStore: false };
  }

  const key = opts.sessionKey;
  if (opts.reset) opts.sessions.reset(key);

  // OpenAI clients often resend full history — trust that transcript.
  if (opts.mode === "auto" && clientSentFullHistory(messages)) {
    return {
      promptText: baseFallback(),
      sessionKey: key,
      usedStore: false,
      mode: "auto",
    };
  }

  const existing = opts.sessions.get(key);
  const hasStore = Boolean(existing && existing.turns.length > 0);

  if (!hasStore) {
    // First turn: use client messages as-is; store will be filled after success.
    return {
      promptText: baseFallback(),
      sessionKey: key,
      usedStore: false,
      mode: opts.mode,
    };
  }

  const mode: "delta" | "full" =
    opts.mode === "full" ? "full" : opts.mode === "delta" ? "delta" : "delta";

  const promptText =
    buildSessionPrompt({
      mode,
      storeTurns: existing!.turns,
      messages,
    }) || baseFallback();

  return {
    promptText,
    sessionKey: key,
    usedStore: true,
    mode,
  };
}

function rememberTurn(
  sessions: SessionStore,
  key: string | undefined,
  meta: { toolId: string; cwd: string },
  messages: ChatMessage[],
  assistantContent: string,
) {
  if (!key) return undefined;
  const userText = latestUserPrompt(messages);
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (userText) turns.push({ role: "user", content: userText });
  if (assistantContent.trim()) turns.push({ role: "assistant", content: assistantContent.trim() });
  if (!turns.length) return sessions.get(key);
  return sessions.append(key, meta, turns);
}

export function createApp(ctx: AppContext) {
  const app = new Hono();

  app.use("*", cors());

  app.use("/v1/*", async (c, next) => {
    const token = ctx.config.authToken;
    if (!token) return next();
    const header = c.req.header("authorization") ?? "";
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== token) {
      return openaiError(401, "Invalid API key", "invalid_api_key");
    }
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      tools: ctx.registry.listToolIds(),
      models: ctx.catalog.list().length,
      sessions: ctx.sessions.size,
    }),
  );

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: ctx.catalog.list(),
    }),
  );

  app.post("/v1/chat/completions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return openaiError(400, "Invalid JSON body");
    }

    const parsed = ChatCompletionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return openaiError(400, parsed.error.message);
    }
    const req = parsed.data;

    let resolved;
    try {
      resolved = ctx.registry.resolveModel(req.model);
    } catch (err) {
      return openaiError(404, err instanceof Error ? err.message : String(err), "model_not_found");
    }

    const spec = ctx.registry.getSpec(resolved.toolId);
    if (!spec) return openaiError(404, `Tool not configured: ${resolved.toolId}`);

    const meta = (req.metadata ?? {}) as Record<string, unknown>;
    const explicitCwd =
      (typeof meta.cwd === "string" && meta.cwd) ||
      (typeof meta.workspace_path === "string" && meta.workspace_path) ||
      spec.cwd ||
      ctx.config.defaultCwd;

    const messages = req.messages as ChatMessage[];
    const cwd = resolveCwd({
      explicit: explicitCwd,
      messages,
      fallback: process.cwd(),
    });

    const trusted =
      meta.trusted === false ||
      meta.untrusted === true ||
      meta.permission_mode === "deny" ||
      meta.permissionMode === "deny"
        ? false
        : meta.trusted === true
          ? true
          : ctx.config.trusted;

    const dryRun = meta.dry_run === true || meta.dryRun === true;
    const sess = sessionMeta(meta);
    const sessionKey = resolveSessionKey({
      sessionId: sess.sessionId,
      user: req.user,
      toolId: resolved.toolId,
      cwd,
    });

    const promptResolved = resolvePromptText({
      sessionEnabled: ctx.config.session.enabled,
      sessionKey,
      mode: sess.mode,
      reset: sess.reset,
      sessions: ctx.sessions,
      toolId: resolved.toolId,
      cwd,
      messages,
    });
    const promptText = promptResolved.promptText;

    const plan = planInvocation({
      spec,
      prompt: promptText,
      cwd,
      trusted,
      modelId: resolved.modelId,
      context: typeof meta.context === "string" ? meta.context : undefined,
    });

    const id = completionId();
    const created = Math.floor(Date.now() / 1000);
    const modelName = resolved.id;

    const sessionInfo = promptResolved.sessionKey
      ? {
          session_key: promptResolved.sessionKey,
          session_mode: promptResolved.mode,
          used_store: promptResolved.usedStore,
          session_turns: ctx.sessions.get(promptResolved.sessionKey)?.turns.length ?? 0,
        }
      : undefined;

    if (dryRun) {
      const cmd = formatPlannedCommand(plan);
      const content = `[dry-run] ${cmd}`;
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        prompt_to_api: {
          plan: { argv: plan.argv, stdin: plan.stdin, cwd: plan.cwd },
          ...(sessionInfo ? { session: sessionInfo } : {}),
        },
      });
    }

    const release = await ctx.gate.acquire(resolved.toolId);
    const abort = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const onSuccess = (content: string) => {
      if (!ctx.config.session.enabled) return undefined;
      const rec = rememberTurn(
        ctx.sessions,
        promptResolved.sessionKey,
        { toolId: resolved.toolId, cwd },
        messages,
        content,
      );
      if (!promptResolved.sessionKey) return undefined;
      return {
        session_key: promptResolved.sessionKey,
        session_mode: promptResolved.mode,
        used_store: promptResolved.usedStore,
        session_turns: rec?.turns.length ?? 0,
      };
    };

    try {
      if (req.stream) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (obj: unknown) => controller.enqueue(enc.encode(toSseChunk(obj)));
            let full = "";
            try {
              const result = await runPlanned({
                plan,
                timeoutMs: ctx.config.timeoutMs,
                signal: abort.signal,
                onStdout: (chunk) => {
                  full += chunk;
                  send({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: modelName,
                    choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
                  });
                },
              });
              if (result.exitCode !== 0 && result.exitCode !== null) {
                const msg = (result.stderr || result.stdout || "agent failed").slice(0, 4000);
                send({ error: { message: msg, type: "agent_error" } });
              } else {
                const sessOut = onSuccess(full.trimEnd());
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                  ...(sessOut ? { prompt_to_api: { session: sessOut } } : {}),
                });
              }
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              send({ error: { message: msg, type: "agent_error" } });
              controller.close();
            } finally {
              release();
            }
          },
          cancel() {
            abort.abort();
            release();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const result = await runPlanned({
        plan,
        timeoutMs: ctx.config.timeoutMs,
        signal: abort.signal,
      });
      release();

      if (result.exitCode !== 0 && result.exitCode !== null) {
        const msg = (result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 4000);
        return openaiError(502, msg, "agent_error");
      }

      const content = result.stdout.trimEnd();
      const sessOut = onSuccess(content);
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        ...(sessOut ? { prompt_to_api: { session: sessOut } } : {}),
      });
    } catch (err) {
      release();
      return openaiError(
        502,
        `Failed to run tool: ${err instanceof Error ? err.message : String(err)}`,
        "agent_error",
      );
    }
  });

  return app;
}
