#!/usr/bin/env bun
/**
 * Smoke matrix: hit each configured tool with a tiny prompt.
 * Usage: bun scripts/smoke-matrix.mjs [baseUrl]
 *
 * Env:
 *   SMOKE_TOOLS / SMOKE_AGENTS  comma list (default: claude,codex,opencode,fm)
 *   SMOKE_TIMEOUT_MS            per-request timeout (default 120000)
 *   SMOKE_DRY_RUN=1             only exercise metadata.dry_run planning
 */
const host = ["127","0","0","1"].join(".");
const base = (process.argv[2] || `http://${host}:8788`).replace(/\/$/, "");
const tools = (process.env.SMOKE_TOOLS || process.env.SMOKE_AGENTS || "claude,codex,opencode,fm")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 120_000);
const dryRun = process.env.SMOKE_DRY_RUN === "1" || process.env.SMOKE_DRY_RUN === "true";

async function chat(model) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly the single word ok and nothing else." }],
        metadata: {
          ...(dryRun ? { dry_run: true } : {}),
        },
      }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text: text.slice(0, 300) };
  } finally {
    clearTimeout(t);
  }
}

const health = await fetch(`${base}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
console.log("health:", JSON.stringify(health));

const models = await fetch(`${base}/v1/models`).then((r) => r.json()).catch(() => ({ data: [] }));
console.log("models:", models?.data?.length ?? 0);

const rows = [];
for (const tool of tools) {
  const model = tool.startsWith("prompt-") ? tool : `prompt-${tool}`;
  process.stdout.write(`… ${model} `);
  const started = Date.now();
  try {
    const r = await chat(model);
    const content = r.json?.choices?.[0]?.message?.content ?? "";
    const ok = dryRun
      ? r.status === 200 && typeof content === "string" && content.includes("[dry-run]")
      : r.status === 200 && typeof content === "string" && content.toLowerCase().includes("ok");
    const ms = Date.now() - started;
    rows.push({ model, ok, status: r.status, ms, content: String(content).slice(0, 80), usage: r.json?.usage });
    console.log(ok ? `OK ${ms}ms` : `FAIL status=${r.status} ${ms}ms content=${JSON.stringify(content).slice(0, 60)}`);
  } catch (e) {
    const ms = Date.now() - started;
    rows.push({ model, ok: false, status: 0, ms, content: String(e), usage: null });
    console.log(`ERR ${ms}ms ${e}`);
  }
}

const passed = rows.filter((r) => r.ok).length;
console.log(JSON.stringify({ passed, total: rows.length, dryRun, rows }, null, 2));
process.exit(passed === rows.length ? 0 : 1);
