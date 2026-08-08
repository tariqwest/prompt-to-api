# prompt-to-api: OpenAI gateway over single-prompt CLIs

## Problem
`acp-to-api` exposes local agents via ACP stdio sessions. Many of the same CLIs also ship a simpler **single-prompt / print / exec** mode (documented in `promptpipe`). We need a sibling gateway, `prompt-to-api`, that speaks the same OpenAI REST surface but drives those headless prompt invocations instead of ACP.

## Current state
- **acp-to-api** (`~/Developer/acp-to-api`): Hono + Bun/Node + Zod; `/v1/models`, `/v1/chat/completions` (+ SSE); agent registry; session pool; model catalog; `init` scans PATH; XDG TOML config; model ids `acp-<agent>[/<model>][@effort]`.
- **promptpipe** (`~/Developer/promptpipe`): adapter catalog for ~27 CLIs with `promptMode` (`arg`|`flag`|`stdin`…), `command`, `trustedArgs`, `modelFlag`, stdin rules. Capability matrix in README is the source of truth for headless run mappings.

## Product shape
```text
OpenAI clients → Hono /v1/* → PromptRunner (spawn CLI once per request)
                              → Adapter catalog (promptpipe-compatible)
```

- Not long-lived ACP sessions. One process per completion in v1.
- Default trusted mode (permission bypass args), overridable via config / request metadata.
- Model ids: `prompt-<tool>`, `prompt-<tool>/<model>`, aliases from promptpipe.

## Architecture
See repository AGENTS.md and README. Built-in catalog ports headless run profiles from promptpipe builtins.

## Implementation phases
1. Planner parity with promptpipe headless run matrix + unit tests
2. Streaming runner + abort + concurrency gate
3. init + TOML overrides + smoke matrix
4. Release scripts / Homebrew formula

## Non-goals (v1)
ACP protocol, full tool-call OpenAI fidelity, skill/slash as first-class API modes, depending on promptpipe at runtime.


## Implementation status
1. Planner parity with promptpipe headless run matrix + unit tests — done
2. Streaming runner + abort + concurrency gate — done
3. init + TOML overrides + smoke matrix — done
4. Release scripts / Homebrew formula — done
