import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppConfig } from "./types.ts";
import { Registry } from "./adapters/registry.ts";
import { ModelCatalog } from "./prompt/catalog.ts";
import { planInvocation, formatPlannedCommand } from "./prompt/planner.ts";
import { ConcurrencyGate, runPlanned } from "./prompt/runner.ts";
import {
  ChatCompletionsRequestSchema,
  completionId,
  openaiError,
  toSseChunk,
} from "./openai/schema.ts";
import { messagesToPrompt, resolveCwd, type ChatMessage } from "./util/messages.ts";

export interface AppContext {
  config: AppConfig;
  registry: Registry;
  catalog: ModelCatalog;
  gate: ConcurrencyGate;
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
    const promptText = messagesToPrompt(messages) || "User: Hello";

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
        prompt_to_api: { plan: { argv: plan.argv, stdin: plan.stdin, cwd: plan.cwd } },
      });
    }

    const release = await ctx.gate.acquire(resolved.toolId);
    const abort = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

    try {
      if (req.stream) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (obj: unknown) => controller.enqueue(enc.encode(toSseChunk(obj)));
            try {
              const result = await runPlanned({
                plan,
                timeoutMs: ctx.config.timeoutMs,
                signal: abort.signal,
                onStdout: (chunk) => {
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
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
