# AGENTS.md

Notes for coding agents working on `prompt-to-api`.

## Overview

OpenAI-compatible gateway that runs **single-prompt / print-mode** CLIs (not ACP). Catalog and headless flag semantics come from `~/Developer/promptpipe` (`src/tools/builtins.ts` + README matrix). HTTP/product shape mirrors `~/Developer/acp-to-api`.

```text
OpenAI Client → Hono (/v1/*) → planInvocation → spawn CLI → stdout → chat.completion
```

## Layout

```text
src/
  index.ts              # CLI entry (server | init | help)
  init.ts               # PATH scan → XDG config.toml
  server.ts             # Hono routes
  config.ts             # defaults + TOML + env
  types.ts
  adapters/catalog.ts   # built-in tool definitions
  adapters/registry.ts  # model id → tool
  prompt/planner.ts     # argv + stdin
  prompt/runner.ts      # spawn + concurrency gate
  prompt/catalog.ts     # /v1/models
  openai/schema.ts
  util/messages.ts
  util/runtime.ts
config/default.json
bin/prompt-to-api.mjs
```

## Conventions

- Bun for dev; Node entry via `tsx` without compiling to JS.
- Hono + Zod (same as acp-to-api).
- Default port **8788** (acp-to-api uses 8787).
- Model prefix **`prompt-`** (acp-to-api uses `acp-`).
- Do not depend on promptpipe as a runtime package; keep catalog in-tree.
- Trusted mode default on; request metadata can disable.

## Commands

```bash
bun test
bun run typecheck
bun run start
bun run start init --yes
```
