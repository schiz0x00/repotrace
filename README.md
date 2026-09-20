# Repotrace

A self-hosted code-intelligence platform that indexes multiple git repositories and exposes fast, high-quality **semantic, lexical, and structural** search to AI coding agents — via an MCP server, a REST API, and a web dashboard.

Repositories are configuration/data, not separate applications. Connect a repo once; Repotrace keeps an incrementally-updated index of files, symbols, chunks, and vectors, and answers natural-language and identifier queries with project-scoped context.

## Features

- **Project + repository management** — create projects from `https://`, `ssh://`, `file://`, or `github.com/owner/repo` shorthand; per-project embedding config; optional HTTPS credentials encrypted at rest (`src/lib/projects/service.ts`).
- **Git synchronization** — blobless clones (`--filter=blob:none`), single-branch fetches, ancestry-aware diffs, and isolated per-project workspaces with retention pruning (`src/lib/git/git.ts`, `src/lib/git/workspace.ts`).
- **Incremental indexing** — content-hash based: unchanged files are skipped, changed files are re-parsed/re-embedded, deleted files are removed from both PostgreSQL and Qdrant. Job types: `initial_index`, `incremental_index`, `full_reindex`, `reembed`, `repository_sync`, `delete_project` (`src/lib/indexing/pipeline.ts`).
- **AST / symbol extraction** — tree-sitter grammars for ~20 languages; symbols with qualified names, kinds, and structural metadata (`calls`, `imports`, `extends`); a synthesized module symbol carries file-level imports/calls (`src/lib/indexing/parser.ts`, `src/lib/indexing/languages.ts`).
- **Semantic chunking** — one chunk per declaration plus bounded gap blocks; fallback block chunking for AST-less languages and markdown section chunking; a malformed file never fails a job (`src/lib/indexing/parser.ts`).
- **Embeddings** — OpenAI-compatible embedding APIs, batched requests (never one request per chunk), retries with exponential backoff, per-project model/version/dimension config (`src/lib/embedding/provider.ts`).
- **Vector storage** — Qdrant, one collection per project (`proj_<id>`) with rich payloads and payload indexes; per-project isolation is structural, not a filter (`src/lib/qdrant.ts`).
- **Hybrid search** — PostgreSQL full-text (lexical) + Qdrant vector similarity + symbol-name search, merged and deterministically reranked with provenance (`vector`/`lexical`/`symbol`) on every result (`src/lib/search/hybrid.ts`, `src/lib/search/lexical.ts`, `src/lib/search/semantic.ts`).
- **Structural queries** — symbol lookup, references (callers), dependencies (calls/imports/extends), tests for a symbol (`src/lib/search/structural.ts`).
- **Context bundles** — the primary retrieval output: a curated, project-scoped answer (relevant symbols + related symbols + tests + docs + relationships) for a natural-language question (`src/lib/search/context.ts`).
- **REST API** — typed, Zod-validated endpoints under `/api/v1/*` (see [API](#api)).
- **MCP server** — streamable-HTTP MCP at `/mcp`; machine-only auth via API keys; every tool is project-scoped (`src/lib/mcp/server.ts`).
- **Webhooks** — GitHub push webhook with HMAC signature validation, delivery deduplication, and debounced incremental indexing; per-project secrets surfaced in project settings (`src/app/api/v1/webhooks/github/route.ts`).
- **Jobs & observability** — BullMQ queue over Redis with PostgreSQL as source of truth; progress/stage/cancel/retry; metric events (latency, failures, queue depth) and a system-health endpoint (`src/lib/jobs/queue.ts`, `src/lib/metrics.ts`, `src/app/api/v1/health/route.ts`).
- **Authentication** — Better Auth email/password (register, login, logout, password reset). Human dashboard sessions and machine/agent credentials (API keys, `rt_…`) are separate; only a SHA-256 hash of each API key is stored (`src/lib/authn.ts`, `src/lib/api-keys.ts`).
- **Dashboard** — shadcn/ui interface: overview (projects, jobs, metrics), auth pages, and a command palette. Search/project pages are under construction.
- **Eval harness** — offline retrieval evaluation over `data/evals/*.json` with recall@k and context-bundle hit rate (`scripts/eval.ts`, see [Evaluation](#evaluation)).

## Architecture

```
                          ┌──────────────────────┐
                          │      Next.js app     │
                          │   dashboard + API +  │
                          │        MCP server    │
                          └──────────┬───────────┘
                                     │  session cookie (human) / Bearer rt_ API key (agent)
                          ┌──────────▼───────────┐
                          │    REST API + MCP    │
                          └──────────┬───────────┘
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
         PostgreSQL            Qdrant (per-project    Redis (BullMQ queue)
         metadata +            collections)           jobs + metrics
         lexical FTS                                  ────────────
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     │
                            ┌────────▼────────┐
                            │  Worker process │
                            └────────┬────────┘
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
              Git sync          Parser/AST          Embedding API
              (blobless)        (tree-sitter)       (OpenAI-compatible)
                 │                   │                   │
                 └───────────────────┼───────────────────┘
                                     │
                                     ▼
                               Qdrant index
```

Flow for a question: `query → hybrid retrieval (lexical + vector + symbol) → merge → deterministic rerank → context bundle` (search route: `src/lib/search/hybrid.ts`, context: `src/lib/search/context.ts`).

## Quickstart

### 1. Infrastructure

The repo ships a `docker-compose.yml` with PostgreSQL, Qdrant, and Redis (plus `app` and `worker` services that build `./Dockerfile`):

```bash
cp .env.example .env          # then edit secrets (BETTER_AUTH_SECRET, REPO_CREDENTIALS_KEY)
docker compose up -d postgres qdrant redis
```

### 2. Run migrations

```bash
npm install
npm run db:deploy             # applies prisma/migrations to the database
npm run db:generate           # regenerates src/generated/prisma if needed
```

### 3. Embedding provider

Either run the deterministic mock server (for local testing only — vectors are content-hash derived, not semantic):

```bash
npm run mock-embeddings       # POST /embeddings on :11435, 64 dims
```

…or point `EMBEDDING_API_URL`/`EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` at any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, a gateway). Per-project overrides are accepted at project create/update.

### 4. Start app + worker

```bash
npm run dev                   # Next.js on http://localhost:3000
npm run worker                # indexing worker (separate terminal)
```

### 5. Create a project and index it

Register an account in the dashboard, then create a project via the API (or the dashboard once project pages ship):

```bash
curl -s http://localhost:3000/api/v1/projects \
  -H "Cookie: <session>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-service",
    "repoUrl": "file:///absolute/path/to/repotrace/data/test-repos/rt-test-repo",
    "provider": "generic",
    "defaultBranch": "main"
  }'
```

Then trigger indexing:

```bash
curl -s -X POST http://localhost:3000/api/v1/projects/order-service/reindex \
  -H "Cookie: <session>" \
  -H "Content-Type: application/json" \
  -d '{"type":"initial"}'
```

Watch `GET /api/v1/projects/order-service/index-status` (or the Jobs page) until the job completes.

### 6. Search

```bash
curl -s "http://localhost:3000/api/v1/projects/order-service/search?q=how+does+order+expiry+work&limit=5" \
  -H "Cookie: <session>"
```

## Environment variables

All infrastructure configuration flows through environment variables, validated at startup by `src/lib/env.ts`. See `.env.example`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | **yes** | — | ≥32 chars; sign sessions, derive per-project webhook secrets |
| `REDIS_URL` | no | `redis://localhost:6379` | BullMQ job queue |
| `QDRANT_URL` / `QDRANT_API_KEY` | no | `http://localhost:6333` / empty | Vector storage |
| `BETTER_AUTH_URL` | no | `http://localhost:3000` | Public base URL for the app (webhook URLs, reset links) |
| `USE_SECURE_COOKIES` | no | `false` | Secure/SameSite=None cookies behind TLS |
| `EMBEDDING_PROVIDER` | no | `openai-compatible` | Embedding provider id |
| `EMBEDDING_API_URL` | no | empty | OpenAI-compatible embeddings endpoint |
| `EMBEDDING_API_KEY` | no | empty | Bearer token for the embedding endpoint |
| `EMBEDDING_MODEL` | no | empty | Embedding model name |
| `EMBEDDING_DIMENSIONS` | no | `1024` | Vector dimensions (must match the model) |
| `EMBEDDING_BATCH_SIZE` | no | `32` | Chunks per embedding request |
| `EMBEDDING_VERSION` | no | `1` | Embedding version — bumped when the model changes; never mixed in one collection |
| `EMBEDDING_TIMEOUT_MS` / `EMBEDDING_MAX_RETRIES` | no | `120000` / `3` | Embedding request timeout / retries |
| `GITHUB_WEBHOOK_SECRET` | no | empty | Global webhook secret; falls back to a per-project derived secret |
| `WORKSPACE_DIR` | no | `data/workspaces` | Repository clone directory |
| `WORKSPACE_RETENTION_DAYS` | no | `7` | Stale workspace cleanup (0 disables) |
| `REPO_CREDENTIALS_KEY` | no | empty | 32-byte base64 key encrypting repository credentials at rest |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | no | — | Password-reset email; unset ⇒ logged to console (dev) |
| `WORKER_CONCURRENCY` | no | `2` | Worker jobs in parallel |
| `JOB_MAX_ATTEMPTS` / `JOB_RETRY_BACKOFF_MS` | no | `3` / `5000` | Job retries |
| `MAX_FILE_SIZE_BYTES` | no | `1000000` | Files larger than this are skipped |

## API

Authenticate with either a dashboard session cookie or an API key (`Authorization: Bearer rt_…`). API keys are created via `POST /api/v1/api-keys` (session required); a key scoped to a project can only access that project. All endpoints validate input with Zod; errors use the shape `{ "error": { "code", "message", "details"? } }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/health` | any principal | PostgreSQL / Qdrant / queue / embedding / sync / workers checks |
| `GET` / `POST` | `/api/v1/projects` | any principal | List (optional `includeStats`), create project + repository |
| `GET` / `PATCH` / `DELETE` | `/api/v1/projects/:idOrSlug` | scoped | Read, update (name/description/branch/url/credentials/embedding), delete (async) |
| `GET` | `/api/v1/projects/:idOrSlug/files` | scoped | Paginated files (`path`, `status`, `language`) |
| `GET` | `/api/v1/projects/:idOrSlug/stats` | scoped | Counts: files, symbols, chunks, commits, failures, languages |
| `GET` | `/api/v1/projects/:idOrSlug/index-status` | scoped | Vectors, failed files, active/last job, embedding config |
| `GET` | `/api/v1/projects/:idOrSlug/search` | scoped | `q`, `mode=hybrid\|lexical\|semantic\|symbol`, `limit`, `chunkTypes`, `languages` |
| `POST` | `/api/v1/projects/:idOrSlug/search/context` | scoped | `{ query, limit? }` → context bundle |
| `GET` | `/api/v1/projects/:idOrSlug/symbols` | scoped | Symbol search (`q`, `kind`, `language`, `limit`) |
| `GET` | `/api/v1/projects/:idOrSlug/symbols/:name/references` | scoped | Callers/usages of a symbol |
| `GET` | `/api/v1/projects/:idOrSlug/symbols/:name/dependencies` | scoped | A symbol's calls/imports/extends |
| `GET` | `/api/v1/projects/:idOrSlug/tests` | scoped | Test files for a `symbol` |
| `POST` | `/api/v1/projects/:idOrSlug/reindex` | scoped | `{ type: initial\|incremental\|full\|reembed }` → job id |
| `POST` | `/api/v1/projects/:idOrSlug/sync` | scoped | Refresh the repository workspace |
| `GET` | `/api/v1/projects/:idOrSlug/webhook` | scoped | Webhook URL + per-project secret |
| `GET` | `/api/v1/search` | scoped | Cross-project convenience: `project`, `q`, `mode`, `limit` |
| `POST` | `/api/v1/search/context` | scoped | `{ project, query, limit? }` → context bundle |
| `GET` | `/api/v1/jobs` | scoped | Job list (`project`, `status`, `type`, `limit`) |
| `GET` | `/api/v1/jobs/:id` | scoped | Job detail |
| `POST` | `/api/v1/jobs/:id/cancel` | scoped | Cooperative cancellation |
| `POST` | `/api/v1/jobs/:id/retry` | scoped | Re-enqueue a failed/cancelled job |
| `GET` | `/api/v1/metrics` | any principal | Aggregated metric summaries + job status counts |
| `GET` / `POST` | `/api/v1/api-keys` | any / session | List; create machine credential (plaintext shown once) |
| `DELETE` | `/api/v1/api-keys/:id` | scoped | Revoke a key |
| `POST` | `/api/v1/webhooks/github` | signature | GitHub push → incremental index |
| `GET` / `POST` | `/mcp` | API key | MCP streamable HTTP endpoint |

## MCP

The MCP server is served over streamable HTTP at `/mcp` and authenticates with an API key only (`Authorization: Bearer rt_…`) — agents never use a browser session. Project-scoped API keys are locked to their project; unscoped keys can target any project via the `project` argument on every tool.

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer rt_<your-api-key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Point any MCP client (Claude, etc.) at `http://localhost:3000/mcp` with the same bearer token. Tools: `list_projects`, `search_code`, `search_docs`, `find_symbol`, `find_references`, `find_dependencies`, `find_tests`, `get_file`, `get_project`, `get_index_status`, `get_context`.

## Evaluation

The offline eval harness replays the exact search the API serves against question sets in `data/evals/*.json` and scores retrieval:

```bash
npm run eval                                # all questions, all projects
npm run eval -- --project order-service     # one project
npm run eval -- --limit 20                  # more results per question
npm run eval -- --json                      # machine-readable report
npm run eval -- --floor 0.5                 # recall@10 floor (default 0.5)
```

Each question is `{ id, projectSlug, query, mode?, expectedFiles, expectedSymbols?, notes? }`. The runner computes file/symbol **recall@5 and recall@10** from `searchProject`, a **context-bundle hit rate** from `buildContextBundle`, prints a per-question + aggregate table, and exits non-zero when aggregate file recall@10 falls below the floor (or when any question fails to run). `data/evals/sample.json` is the seed set for the `order-service` test repo (`data/test-repos/rt-test-repo`); it includes deliberately hard canaries (e.g. multi-word lexical queries) so regressions are visible. For clean piped JSON use `npx tsx scripts/eval.ts --json`.

## Testing

```bash
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint
npm test                       # vitest run
```

Vitest is wired but no suites exist yet — add them under `tests/`.

## Project layout

```
src/
  app/
    api/v1/…        REST API route handlers (projects, search, jobs, api-keys, webhooks, metrics, health)
    api/webhooks/   GitHub webhook entry point
    mcp/            MCP streamable-HTTP transport
    (dashboard)/    dashboard pages (overview, jobs, metrics)
    (auth)/         login / signup / password reset
  lib/
    search/         hybrid, lexical, semantic, structural search + context bundles
    indexing/       pipeline, tree-sitter parser, language registry
    embedding/      OpenAI-compatible provider (batching, retries)
    git/            git CLI wrapper + workspaces
    github/         webhook signature validation
    jobs/           BullMQ queue
    mcp/            MCP tool registry
    projects/       project lifecycle
  worker/           BullMQ worker (indexing, sync, delete jobs)
  components/       shadcn/ui components + dashboard widgets
scripts/
  eval.ts           offline retrieval evaluation
  mock-embeddings.mjs   deterministic OpenAI-compatible mock
data/
  evals/            question sets for the eval harness
  test-repos/       fixture repositories
  workspaces/       clone working dirs (gitignored)
prisma/             schema + migrations
Dockerfile          multi-stage image (app + worker)
docker-compose.yml  postgres / qdrant / redis / app / worker
```

## Docker image notes

`npm run start` (`next start`) and the worker (`tsx src/worker/index.ts`) share one image built from `./Dockerfile`. The runtime stage keeps the source tree + config because the worker is runtime-compiled by `tsx`. It installs `git` (the indexer shells out to the git CLI) and uses `npm ci --omit=dev` for prod-only dependencies. Tree-sitter grammars ship prebuilt native binaries for `linux-x64`/`linux-arm64`; they require glibc (provided by the `node:24-bookworm-slim` base) and no extra build toolchain. Health is surfaced at `/api/v1/health` (requires auth); wire a healthcheck to it or probe the root route from your proxy/`curl`.