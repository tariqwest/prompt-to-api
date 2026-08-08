import { loadConfig } from "./config.ts";
import { Registry } from "./adapters/registry.ts";
import { ModelCatalog } from "./prompt/catalog.ts";
import { ConcurrencyGate } from "./prompt/runner.ts";
import { SessionStore } from "./prompt/session-store.ts";
import { createApp } from "./server.ts";
import { runInit } from "./init.ts";
import { startServer } from "./util/runtime.ts";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "init" || command === "--init") {
    await runInit(args.slice(1));
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`prompt-to-api - OpenAI-compatible REST gateway for single-prompt AI CLIs

Usage:
  prompt-to-api [command] [options]

Commands:
  (default)       Start the API server gateway
  init            Initialize config.toml with detected local CLI tools
  help            Show this help message

Options for init:
  -y, --yes       Automatically enable all detected tools without prompting
  --config <path> Custom path for config.toml
`);
    return;
  }

  const config = await loadConfig();

  const registry = new Registry(config);
  const catalog = new ModelCatalog(registry);
  const gate = new ConcurrencyGate(config.concurrency.maxGlobal, config.concurrency.maxPerAgent);
  const sessions = new SessionStore({
    ttlMs: config.session.ttlMs,
    maxSessions: config.session.maxSessions,
    maxTurns: config.session.maxTurns,
    maxChars: config.session.maxChars,
    persistDir: config.session.persistDir,
    flushIntervalMs: config.session.flushIntervalMs,
  });
  if (config.session.enabled && config.session.persistDir) {
    const n = await sessions.init();
    console.error(
      `[prompt-to-api] session snapshots: loaded ${n} from ${config.session.persistDir}`,
    );
  }

  console.error("[prompt-to-api] detecting tools…");
  await catalog.bootstrap();
  const models = catalog.list();
  console.error(`[prompt-to-api] models ready: ${models.length}`);
  console.error(
    `[prompt-to-api] tools: ${models.map((m) => m.metadata?.toolId).filter(Boolean).join(", ") || "(none)"}`,
  );
  console.error(
    `[prompt-to-api] sessions: ${
      config.session.enabled
        ? `on (ttl=${config.session.ttlMs}ms${config.session.persistDir ? `, persist=${config.session.persistDir}` : ", memory-only"})`
        : "off"
    }`,
  );

  const app = createApp({ config, registry, catalog, gate, sessions });
  const server = await startServer(app, { host: config.host, port: config.port });

  console.error(`[prompt-to-api] listening on http://${server.hostname}:${server.port}`);
  console.error(`[prompt-to-api] OpenAI base URL: http://${server.hostname}:${server.port}/v1`);

  const shutdown = async () => {
    console.error("[prompt-to-api] shutting down…");
    try {
      await sessions.close();
    } catch (err) {
      console.error("[prompt-to-api] session flush error:", err);
    }
    await server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
