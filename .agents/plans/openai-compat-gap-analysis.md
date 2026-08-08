# prompt-to-api: OpenAI-compatible API gap analysis

## Context
`prompt-to-api` exposes an OpenAI-shaped HTTP edge (`/v1/models`, `/v1/chat/completions`) but implements completions by flattening chat messages into one prompt, spawning a headless CLI, and wrapping stdout. This document captures capabilities typically available from models through an OpenAI-compatible server that are missing, faked, or only partial in this prompt-wrapper approach.

Related:
- Architecture plan: `.agents/plans/prompt-to-api.md`
- Sibling ACP gateway: `~/Developer/acp-to-api` (richer session/tool events via ACP)

## What we support today (baseline)
- `GET /v1/models` — tool-as-model list (PATH-detected / enabled tools)
- `POST /v1/chat/completions` — non-stream and SSE stream of raw stdout chunks
- Optional Bearer auth (`authToken` / `PROMPT_TO_API_TOKEN`)
- Model routing: `prompt-<tool>`, `prompt-<tool>/<model>`, aliases
- Client disconnect → subprocess abort
- Concurrency gate (global + per-tool)
- Gateway metadata: `cwd`, `trusted`/`untrusted`, `dry_run`, `context`

## Structural difference
| OpenAI-compatible model server | prompt-to-api wrapper |
|---|---|
| Talks a model protocol with structured events | Spawns a human/agent CLI once per request |
| Returns tokens, tool calls, usage | Returns process stdout/stderr |
| Holds conversation state in API terms | Rebuilds one prompt string every time |
| Can enforce sampling/limits | Depends on whatever each CLI exposes |

Many gaps are not just unfinished endpoints — they are hard or impossible without richer CLI machine interfaces (JSON event streams, session IDs, usage) or a different backend (ACP, provider SDKs).

## Major gaps

### 1. API surface
Missing common routes clients often expect:
- `/v1/responses` (Responses API)
- `/v1/completions` (legacy text completions)
- `/v1/embeddings`
- `/v1/audio/*` (speech / transcription)
- `/v1/images/*`
- `/v1/moderations`
- `/v1/files`, `/v1/batches`, `/v1/fine_tuning/*`
- `GET /v1/models/{id}`
- Real cancel/status APIs beyond “client closed the HTTP stream”

### 2. Chat Completions request semantics
Accepted, ignored, or not truly honored:
- `tools` / `tool_choice` / function calling — accepted in Zod schema, never executed or returned as structured `tool_calls`
- `temperature`, `top_p`, `top_k`, `presence_penalty`, `frequency_penalty`, `seed`, `n`, `stop`, `logit_bias`, `logprobs`
- `max_tokens` / `max_completion_tokens` — accepted, not enforced
- `response_format` / JSON mode / structured outputs (`json_object`, `json_schema`)
- `reasoning_effort` / thinking controls as first-class OpenAI fields (only via incidental CLI flags/model ids)
- `stream_options` (e.g. include usage on stream)
- `parallel_tool_calls`, `audio`, `modalities`, `prediction`, `service_tier`, etc.

### 3. Message / multimodal fidelity
- History flattened to text (`System:` / `User:` / `Assistant:`), not true multi-turn model state
- No real role fidelity beyond string prefixes
- No image/audio/file parts (vision / input files)
- No name / function-role message handling as protocol
- No assistant prefill / partial assistant continuation semantics
- No first-class system-prompt channel separate from flattened text (CLI-dependent)

### 4. Tool use / agent protocol (highest practical gap)
Normal OpenAI tools loop:
1. model returns `tool_calls`
2. client runs tools
3. client sends `role: tool` results
4. model continues

prompt-to-api does not implement this. The CLI may use tools internally, but the API only sees opaque stdout. Missing:
- Structured `message.tool_calls`
- Streaming tool-call deltas
- Tool-result round-trips through the OpenAI schema
- OpenAI-style “assistant requests client-side tools” contract

Note: `acp-to-api` is closer via ACP tool events; this project is not.

### 5. Streaming quality
Current stream = stdout chunk → `delta.content`.
Missing or weak:
- Token-level deltas (often byte/line/process buffered)
- Role/content split events (`delta.role`)
- Tool-call / reasoning / citation event types
- Mid-stream error framing that all clients handle consistently
- `finish_reason` variety (`length`, `tool_calls`, `content_filter`; we mostly emit `stop`)
- Usage on final chunk when requested
- Heartbeats / keepalives for long agent runs

### 6. Usage, billing, limits
- `usage` always zeros
- No prompt-cache reporting
- No rate-limit headers (`x-ratelimit-*`)
- No request id / org / project headers for support/debug
- No per-key quotas beyond optional shared bearer token

### 7. Model catalog realism
`/v1/models` is effectively “CLI wrappers on PATH,” not model inventory:
- No discovered upstream model lists (unless configured)
- No context-window / modality / pricing metadata
- No capability flags (tools / vision / json)
- `prompt-<tool>/<model>` only works when adapter defines `modelFlag`

### 8. Session / state
- No multi-turn session reuse (each request = new process)
- `user` accepted but unused for affinity
- No conversation store / server-side memory
- No resumable responses / background runs
- No “continue from previous response id”

### 9. Determinism and decoding controls
Generally cannot guarantee via CLI wrap:
- Seeded reproducibility
- Exact stop sequences
- Token budgets
- Logprobs
- Best-of / `n > 1` multiple choices

### 10. Safety / moderation / policy
Missing:
- Content moderation endpoints
- Consistent content-filter finish reasons
- Output redaction policies
- Per-tenant safety profiles

(We only expose CLI trusted/untrusted permission-bypass metadata — a different axis.)

### 11. Operational API maturity
Often expected in gateways, not present:
- Request/response logging with redaction
- Tracing (`traceparent`, OpenTelemetry)
- Metrics (latency, tokens, error classes)
- Per-model timeouts / retries / backoff
- Idempotency keys
- Webhooks
- Multi-tenant API keys with scopes

## Highest-impact missing pieces for drop-in clients
1. Tool / function calling
2. Real multi-turn state (not flattened transcript)
3. Token usage
4. JSON / structured output mode
5. Sampling + max-token controls
6. Vision / multimodal inputs
7. `/v1/responses`
8. Reliable streaming semantics + finish reasons
9. Model capability discovery
10. Embeddings (many apps assume same base URL)

## Good fit already
- One-shot “ask this coding agent and return text”
- Clients that only need `chat.completions` text out
- Routing across local CLIs with OpenAI SDKs
- Dry-run / plan inspection and cwd / trusted controls via metadata

## Prioritization sketch (for future work)
### Easy / partial (gateway-only)
- Richer error + finish_reason mapping
- Request ids / basic rate-limit headers
- `GET /v1/models/{id}`
- Document ignored request fields explicitly
- Optional stderr separation / debug metadata
- Heartbeat SSE comments on long runs

### Medium (needs per-CLI flags or light parsing)
- Forward temperature/max_tokens/seed when adapters declare flags
- Parse CLI JSON output modes into message content / usage when available
- Static or config-driven upstream model lists + capability metadata
- Better streaming chunking and final usage if CLI emits it

### Hard (needs session or event protocol)
- True multi-turn affinity / resume
- OpenAI tool_calls loop with client-side tools
- Structured outputs enforced end-to-end
- Accurate token usage
- `/v1/responses` parity

### Better elsewhere
- Full multimodal provider parity → provider SDKs or cloud gateways
- Deep agent tool protocol → `acp-to-api` / ACP
- Embeddings / images / audio → dedicated backends

## Decision guidance
Use **prompt-to-api** when the product is “OpenAI client → local print-mode coding CLI → text.”
Use **acp-to-api** when you need session reuse and tool event surfaces.
Use a real model proxy when you need embeddings, strict sampling, structured outputs, or billing-grade usage.

## Source snapshot
Derived from implementation review of:
- `src/server.ts`
- `src/openai/schema.ts`
- `src/prompt/planner.ts` / `runner.ts`
- `README.md` behavior notes

Captured: 2026-08-08
