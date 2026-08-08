# prompt-to-api

OpenAI-compatible REST gateway for local **single-prompt / print-mode** AI CLIs.

Sibling to [acp-to-api](https://github.com/tariqwest/acp-to-api) (ACP stdio sessions). This project instead spawns each CLI **once per completion** using the same headless mappings documented in [promptpipe](https://github.com/tariqwest/promptpipe).

```text
OpenAI clients → Hono /v1/* → PromptRunner → claude -p | codex exec | opencode run | …
```

| | acp-to-api | prompt-to-api |
|---|---|---|
| Transport | ACP stdio sessions | One-shot CLI process per request |
| Default port | 8787 | 8788 |
| Model id prefix | `acp-` | `prompt-` |
| Multi-turn | Session reuse via `metadata.session_id` | Full chat flattened into one prompt (v1) |

## Requirements

- [Bun](https://bun.sh) 1.1+ (recommended), or Node.js 20+ with the bundled `tsx` entry
- One or more supported AI CLIs on `PATH`

## Install

### From source

```bash
cd ~/Developer/prompt-to-api
bun install
```

### Global (when published)

```bash
bun add -g prompt-to-api
# or
npm install -g prompt-to-api
```

The package bin is `prompt-to-api` (`bin/prompt-to-api.mjs`). Under Bun it loads TypeScript directly; under Node it runs via `tsx`.

## Quick start

```bash
cd ~/Developer/prompt-to-api
bun install

# Optional: scan PATH and write ~/.config/prompt-to-api/config.toml
bun run start init --yes

# Start gateway (default http://127.0.0.1:8788)
bun run start
```

In another terminal:

```bash
export BASE=http://127.0.0.1:8788

curl -s "$BASE/health" | jq

curl -s "$BASE/v1/models" | jq '.data[].id'

# Dry-run: plan argv without spawning the CLI
curl -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "prompt-claude",
    "messages": [{"role":"user","content":"Reply with the word pong only."}],
    "metadata": {"dry_run": true}
  }' | jq

# Real completion (requires `claude` on PATH)
curl -s "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "prompt-claude",
    "messages": [{"role":"user","content":"Reply with the word pong only."}]
  }' | jq -r '.choices[0].message.content'

# Streaming SSE
curl -sN "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "prompt-codex",
    "stream": true,
    "messages": [{"role":"user","content":"Say hi in one short sentence."}]
  }'
```

Point any OpenAI-compatible client at `http://127.0.0.1:8788/v1` (API key optional unless `PROMPT_TO_API_TOKEN` / config `authToken` is set).

## CLI

```bash
prompt-to-api              # start server
prompt-to-api init         # write config.toml from PATH scan
prompt-to-api init --yes   # enable all catalog tools in config (not only detected)
prompt-to-api init --config /path/to/config.toml
prompt-to-api help
```

With Bun from the repo:

```bash
bun run start
bun run start init --yes
bun run dev          # watch mode
bun test
bun run typecheck
```

## HTTP API

### `GET /health`

```json
{ "status": "ok", "tools": ["claude", "codex", "..."], "models": 12 }
```

### `GET /v1/models`

OpenAI list shape. Each entry is typically `prompt-<tool>` for tools detected on `PATH` (or all enabled tools if none are detected).

### `POST /v1/chat/completions`

Standard OpenAI chat body. Messages are flattened into a single prompt string (`System:` / `User:` / `Assistant:` blocks) and passed to the selected CLI.

| Request field | Behavior |
|---|---|
| `model` | Required. See [Model ids](#model-ids). |
| `messages` | Flattened into one prompt. |
| `stream` | If `true`, stdout is forwarded as SSE `chat.completion.chunk` deltas. |
| `user` | Accepted; not used for session affinity in v1. |
| `metadata` | Gateway extensions (below). |

#### Metadata

| Field | Purpose |
|---|---|
| `cwd` / `workspace_path` | Working directory for the CLI subprocess |
| `trusted` | `true`/`false` — include adapter permission-bypass args (default from config, usually on) |
| `untrusted` | `true` — same as `trusted: false` |
| `permission_mode` / `permissionMode` | `"deny"` disables trusted bypass args |
| `dry_run` / `dryRun` | `true` — return planned command; do not spawn |
| `context` | Extra string piped on stdin when the adapter's `stdinMode` allows |

Dry-run responses include `prompt_to_api.plan` with `argv`, `stdin`, and `cwd`.

#### Auth

If `authToken` is set (config or `PROMPT_TO_API_TOKEN`), send:

```http
Authorization: Bearer <token>
```

## Model ids

- `prompt-<tool>` — tool default upstream model
- `prompt-<tool>/<model>` — pass `<model>` via the adapter `modelFlag` when defined (e.g. `prompt-claude/sonnet`)
- Prefix forms `prompt/` and bare tool / alias names are also accepted when unambiguous
- Aliases: `antigravity` → `agy`, `shellgpt` → `sgpt`, `claude-code` → `claude`, `oc` → `opencode`, etc.

Examples: `prompt-claude`, `prompt-codex`, `prompt-opencode/claude-sonnet-4`, `prompt-oz`.

## Built-in tools

Headless **run** profiles are ported from promptpipe's capability matrix (interactive / shell / skill overlays are not first-class API modes in v1):

| Id | Typical headless invocation |
|---|---|
| `codex` | `codex exec <prompt>` (+ trusted sandbox bypass) |
| `claude` | `claude -p <prompt>` |
| `hermes` | `hermes -z <prompt>` |
| `fm` | `fm respond --no-stream <prompt>` |
| `goose` | `goose run -q -t <prompt>` |
| `copilot` | `copilot -p <prompt> -s` |
| `cursor` | `cursor-agent -p <prompt>` |
| `opencode` | `opencode run <prompt>` |
| `devin` | `devin -p <prompt>` |
| `grok` | `grok -p <prompt>` |
| `kiro` | `kiro-cli-chat chat --no-interactive <prompt>` |
| `agy` | `agy -p <prompt>` |
| `qoder` | `qodercli -p <prompt>` |
| `junie` | `junie --task <prompt>` |
| `aider` | `aider --message <prompt> --no-stream` |
| `cline` | `cline <prompt>` |
| `amp` | `amp -x <prompt>` |
| `droid` | `droid exec <prompt>` |
| `pi` | `pi -p <prompt>` |
| `crush` | `crush run <prompt>` |
| `mods` | `mods <prompt> --raw` |
| `sgpt` | `sgpt <prompt>` |
| `aichat` | `aichat <prompt> --no-stream` |
| `oz` | `oz agent run --prompt <prompt>` |
| `fast-agent` | `fast-agent go --message <prompt> --quiet` |

Exact flags (including trusted bypass args) live in `src/adapters/catalog.ts`. Prefer `metadata.dry_run` to inspect the planned command for your install.

## Configuration

Load order:

1. Built-in catalog (`src/adapters/catalog.ts`)
2. Package `config/default.json`
3. User TOML: `$XDG_CONFIG_HOME/prompt-to-api/config.toml` (default `~/.config/prompt-to-api/config.toml`), or path from `PROMPT_TO_API_CONFIG`
4. Environment variables

### Example `config.toml`

```toml
host = "127.0.0.1"
port = 8788
trusted = true
timeout_ms = 600000
default_cwd = "~/.config/prompt-to-api/cwd"

[concurrency]
max_global = 8
max_per_agent = 2

[tools.claude]
enabled = true
# optional overrides: command, prompt_mode, prompt_flag, model_flag, trusted_args, extra_args, aliases, cwd
```

Generate a full file with `prompt-to-api init`.

### Environment

| Env | Purpose |
|---|---|
| `PROMPT_TO_API_CONFIG` | Custom config file path |
| `PROMPT_TO_API_HOST` | Bind host (default `127.0.0.1`) |
| `PROMPT_TO_API_PORT` | Port (default `8788`) |
| `PROMPT_TO_API_TOKEN` | Optional Bearer token |
| `PROMPT_TO_API_CWD` | Default workspace for CLI subprocesses |
| `PROMPT_TO_API_TRUSTED` | `1`/`0` — default permission bypass |
| `PROMPT_TO_API_TIMEOUT_MS` | Per-request subprocess timeout (default 600000) |

## Behavior notes

- **No long-lived agent sessions** in v1 — each request is a new process.
- **Trusted mode** defaults on (promptpipe-style bypass flags). Turn off via config, env, or request metadata for safer interactive-permission behavior.
- **Concurrency** is limited globally and per tool (`concurrency` / `pool` in config); this is a gate, not session reuse.
- **Usage tokens** are returned as zeros unless extended later; CLIs rarely emit OpenAI-shaped usage on stdout.
- Non-zero CLI exit → HTTP `502` with truncated stderr (`agent_error`).

## Development

```bash
bun test             # unit tests (planner, …)
bun run typecheck    # tsc --noEmit
bun run dev          # server with --watch
bun run start        # server
```

Architecture notes for agents: [AGENTS.md](./AGENTS.md).  
Design plan: [`.agents/plans/prompt-to-api.md`](./.agents/plans/prompt-to-api.md).

## License

MIT
