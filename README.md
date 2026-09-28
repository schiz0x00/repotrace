# Repotrace

A self-hosted code-intelligence platform that indexes multiple git repositories and exposes fast, high-quality **semantic, lexical, and structural** search to AI coding agents — via an MCP server, a REST API, and a web dashboard.

Repositories are configuration/data, not separate applications. Connect a repo once; Repotrace keeps an incrementally-updated index of files, symbols, chunks, and vectors, and answers natural-language and identifier queries with project-scoped context.

## Features

- **Project + repository management** — create projects from `https://`, `ssh://`, `file://`, or `github.com/owner/repo` shorthand; per-project embedding config; optional HTTPS credentials encrypted at rest (`src/lib/projects/service.ts`).
- **Git synchronization** — blobless clones (`--filter=blob:none`), single-branch fetches, ancestry-aware diffs, and isolated per-project workspaces with retention pruning (`src/lib/git/git.ts`, `src/lib/git/workspace.ts`).
- **Incremental indexing** — content-hash based: unchanged files are skipped, changed files are re-parsed/re-embedded, deleted files are removed from both PostgreSQL and Qdrant. Job types: `initial_index`, `incremental_index`, `full_reindex`, `reembed`, `repository_sync`, `delete_project` (`src/lib/indexing/pipeline.ts`).
- **AST / symbol extraction** — tree-sitter grammars for 15 languages; symbols with qualified names, kinds, and structural metadata (`calls`, `imports`, `extends`); a synthesized module symbol carries file-level imports/calls (`src/lib/indexing/parser.ts`, `src/lib/indexing/languages.ts`). The registry declares 22 language ids in total — 16 are grammar-backed (13 of those also yield symbols; JSON, CSS and HTML are parsed but not mined for declarations) and 6 more (markdown, yaml, toml, sql, dockerfile, makefile) are extension-detected only and fall through to the chunker. The exact list is `LANGUAGES` in `src/lib/indexing/languages.ts`; the number is not hard-coded anywhere else.
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
- **Authentication** — Better Auth email/password (register, login, logout, password reset; reset needs `SMTP_HOST` set, or the route refuses with 503). Human dashboard sessions and machine/agent credentials (API keys, `rt_…`) are separate; only a SHA-256 hash of each API key is stored (`src/lib/authn.ts`, `src/lib/api-keys.ts`).
- **Dashboard** — shadcn/ui interface: overview (projects, jobs, metrics), auth pages, and a command palette, plus live Search, Projects list/create, per-project detail (overview, files, symbols, search, jobs, commits, retrieval quality, settings), Jobs, Embeddings, System Health and Settings pages. Every page that shows data reads the `/api/v1` endpoints documented below — server components through `api()` in `src/components/dashboard/data.ts` (which forwards the session cookie), client components through `getJson`/`postAction`. Two things are not `/api/v1`: sign-in/register/logout go through Better Auth at `/api/auth/*`, and the Settings page's session list and session revocation read the `session` table through Prisma inside the server component / server function (`src/app/(dashboard)/settings/page.tsx`) instead of going over HTTP at all.
- **Eval harness** — offline retrieval evaluation over JSON question sets in `data/evals/` (a directory you create; `/data/` is gitignored and ships no seed set) with recall@k and context-bundle hit rate (`scripts/eval.ts`, see [Evaluation](#evaluation)).

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

The compose stack is **not** an unauthenticated stack on a routable interface. It reads three infrastructure credentials, and they must match the values the app itself uses:

| Variable | Consumed by compose as | Fallback if unset | Must match |
|---|---|---|---|
| `POSTGRES_PASSWORD` | `postgres` service, and the `DATABASE_URL`/`REDIS_URL` the `app` and `worker` services are given | `repotrace` | the password inside your `DATABASE_URL` |
| `REDIS_PASSWORD` | `redis-server --requirepass`, and the `REDIS_URL` given to `app`/`worker` | `repotrace-redis` | your `REDIS_URL` must carry it as `redis://:<password>@host:6379` |
| `QDRANT_API_KEY` | `QDRANT__SERVICE__API_KEY`, and the `QDRANT_API_KEY` given to `app`/`worker` | `repotrace-qdrant` | your `QDRANT_API_KEY` |

Repository clones go in the named `workspaces` volume, not in the host's `./data`. The image runs as uid 1001 while `./data` belongs to whoever ran `docker compose`, so a bind-mounted workspace directory was unwritable and every index job failed with `EACCES`. The volume is seeded from `/app/data/workspaces` in the image, which is owned by the runtime user. `./data` is still bind-mounted because the eval harness and the integration-test fixtures live there — note that `/data/` is gitignored, so neither of those directories is populated in a fresh clone.

Two consequences that are easy to miss:

- **Redis is started with `--requirepass`.** A `REDIS_URL` without the password (`redis://localhost:6379`) is refused by the server. `.env.example` ships the password-bearing URL for this reason.
- **Qdrant requires the API key.** Without it Qdrant accepts anonymous *reads and writes* — anyone who can reach 6333 can read every indexed chunk or delete the collections. The compose healthcheck supplies the key, so an unauthenticated probe correctly reports unhealthy.

All three ports are published on `127.0.0.1` only. That is the safe default for a single-host install; if you intend to reach any of them from another machine, change the credentials first and re-expose deliberately.

### 2. Run migrations

```bash
npm install
npm run db:deploy             # applies prisma/migrations to the database
npm run db:generate           # regenerates src/generated/prisma if needed
```

### 3. Embedding provider

Either run the deterministic mock server (for local testing only — vectors are content-hash derived, not semantic):

```bash
# The second argument is the vector width and MUST equal EMBEDDING_DIMENSIONS,
# or the collection and the chunks written into it disagree on dimension.
npm run mock-embeddings -- 11435 768     # matches EMBEDDING_DIMENSIONS in .env.example
```

The mock server defaults to 64 dimensions on its own, which does not match the 768 that `.env.example` sets — pass the width explicitly, or set `EMBEDDING_DIMENSIONS=64` to match it. It also listens on **:11435**, while the `EMBEDDING_API_URL` in `.env.example` points at Ollama's **:11434**; if you are using the mock, set `EMBEDDING_API_URL="http://localhost:11435"` and leave `EMBEDDING_MODEL` non-empty (the mock echoes back whatever `model` you send and never validates it).

**The base URL for the mock must have no `/v1` suffix.** The app issues exactly one request shape — `POST ${EMBEDDING_API_URL}/embeddings` (`src/lib/embedding/provider.ts`) — and the mock answers only `POST /embeddings` at its root, 404ing anything else (`scripts/mock-embeddings.mjs` matches `req.url.startsWith("/embeddings")`). Pointing at `http://localhost:11435/v1` therefore asks for `/v1/embeddings`, which the mock 404s, and every embedding call fails with `Embedding API returned HTTP 404`. The `/v1` prefix belongs to OpenAI-compatible servers like Ollama that mount the route under it; the mock does not.

…or point `EMBEDDING_API_URL`/`EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` at any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, a gateway). Per-project overrides are accepted at project create/update.

### 4. Start app + worker

```bash
npm run dev                   # Next.js on http://localhost:3000
npm run worker                # indexing worker (separate terminal)
```

### 5. Create a project and index it

Register an account in the dashboard, then create a project in the dashboard (**Projects → New project**) or via the API. `repoUrl` must be something git can clone — a remote, or a local path/URL pointing at a **git repository with at least one commit on the branch you name**; the example below is a local one:

```bash
curl -s http://localhost:3000/api/v1/projects \
  -H "Cookie: <session>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-service",
    "repoUrl": "file:///absolute/path/to/your/git/repo",
    "provider": "generic",
    "defaultBranch": "main"
  }'
```

> **There is no bundled test repository.** An earlier version of this README pointed at `data/test-repos/rt-test-repo`. The whole `/data/` directory is gitignored, so a fresh clone has no `data/evals/` and no `data/test-repos/` — the fixture's contents are not in version control and are not fetched by anything in this repo. (One file from it did get committed by accident, `docs/FLOWS.md`, which is a copy of the fixture's `docs/FLOWS.md`; it documents the fictional order service, not this codebase, and cannot be used to reconstruct the repository.) Substitute your own repository as above; if you also change the project **name**, remember that the later steps address it by slug, and `order-service` below is just the example's. `data/workspaces/` needs no setup — it is created on first clone. See [Evaluation](#evaluation) for what the missing `data/evals/` means for `npm run eval`.

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

All infrastructure configuration flows through environment variables, validated at startup by `src/lib/env.ts` (a Zod schema — an unparseable value throws at first access, not at request time). The "Default" column is the schema default in `src/lib/env.ts`, which is not always what `.env.example` sets; where the two differ the row says so. Variables read by `docker-compose.yml` rather than by the app (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`) are covered in [Infrastructure](#1-infrastructure) and are deliberately absent here.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | Standard Node mode. `production` changes the SMTP fallback from a log line to a hard error |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | **yes** | — | ≥32 chars; sign sessions, derive per-project webhook secrets |
| `REDIS_URL` | no | `redis://localhost:6379` | BullMQ job queue. Must carry the password when Redis runs with `--requirepass` (as the compose stack does) |
| `QDRANT_URL` / `QDRANT_API_KEY` | no | `http://localhost:6333` / empty | Vector storage. The key is required against a Qdrant started with an API key |
| `BETTER_AUTH_URL` | no | `http://localhost:3000` | Public base URL for the app (webhook URLs, reset links) |
| `USE_SECURE_COOKIES` | no | `false` | Secure/SameSite=None cookies behind TLS |
| `EMBEDDING_PROVIDER` | no | `openai-compatible` | Embedding provider id |
| `EMBEDDING_API_URL` | no | empty | OpenAI-compatible embeddings endpoint |
| `EMBEDDING_API_KEY` | no | empty | Bearer token for the embedding endpoint |
| `EMBEDDING_MODEL` | no | empty | Embedding model name |
| `EMBEDDING_DIMENSIONS` | no | `1024` (`.env.example` sets `768`) | Vector dimensions (must match the model) |
| `EMBEDDING_BATCH_SIZE` | no | `32` | Chunks per embedding request |
| `EMBEDDING_VERSION` | no | `1` | Embedding version — bumped when the model changes; never mixed in one collection |
| `EMBEDDING_TIMEOUT_MS` / `EMBEDDING_MAX_RETRIES` | no | `120000` / `3` | Embedding request timeout / retries |
| `GITHUB_WEBHOOK_SECRET` | no | empty | Global webhook secret; falls back to a per-project derived secret |
| `WORKSPACE_DIR` | no | `data/workspaces` | Repository clone directory |
| `WORKSPACE_RETENTION_DAYS` | no | `7` | Stale workspace cleanup (0 disables) |
| `REPO_CREDENTIALS_KEY` | no | empty | 32-byte base64 key encrypting repository credentials at rest |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | no | — | Password-reset email. `SMTP_HOST` empty means **no mail transport**: the auth route answers any `request-password-reset` / `reset-password` POST with `503 email_delivery_unavailable` and never reaches `sendMail` (`src/app/api/auth/[...all]/route.ts`). `sendMail`'s own console branch — print the message to stdout outside production, throw in production — exists but is unreachable over HTTP; it is exercised only by direct calls and tests (`src/lib/mailer.ts`) |
| `WORKER_CONCURRENCY` | no | `2` | Worker jobs in parallel |
| `JOB_MAX_ATTEMPTS` / `JOB_RETRY_BACKOFF_MS` | no | `3` / `5000` | Job retries |
| `MAX_FILE_SIZE_BYTES` | no | `1000000` | Files larger than this are skipped |
| `METRIC_RETENTION_DAYS` | no | `30` | How long `metric_event` rows are kept (0 disables pruning) |

## API

Authenticate with either a dashboard session cookie or an API key (`Authorization: Bearer rt_…`). API keys are created via `POST /api/v1/api-keys` (session required); a key scoped to a project can only access that project. All endpoints validate input with Zod; errors use the shape `{ "error": { "code", "message", "details"? } }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/health` | public | Liveness probe: Postgres / Qdrant / queue booleans only. Each check is bounded (5s), so a wedged dependency fails fast instead of holding the request. Returns 503 when degraded |
| `GET` | `/api/v1/health/status` | any principal | Full diagnostics: embedding probe, per-repository sync state, worker heartbeat. Authentication is itself bounded; a rejected credential is still a 401, and only a failure to authenticate in time is the 503 |
| `GET` / `POST` | `/api/v1/projects` | any principal; a project-scoped key is limited to its own project | List (optional `includeStats`), create project + repository. A project-scoped key gets 403 `project_create_forbidden` rather than creating a project outside its scope |
| `GET` / `PATCH` / `DELETE` | `/api/v1/projects/:idOrSlug` | scoped | Read, update (name/description/branch/url/credentials/embedding), delete (async) |
| `GET` | `/api/v1/projects/:idOrSlug/files` | scoped | Paginated files (`path`, `status`, `language`) |
| `GET` | `/api/v1/projects/:idOrSlug/files/outline` | scoped | Structure of one indexed file: every symbol with `name`, `qualifiedName`, `kind`, line span and `parentName`, plus language, size and last indexed commit. `path` **required**; 404 when the file is not indexed *in this project* |
| `GET` | `/api/v1/projects/:idOrSlug/files/content` | scoped | The file's text over a line range, reassembled from its chunks and returned with line numbers. `path` **required**, `startLine`/`endLine` optional and clamped to the file's real bounds. `truncation` states exactly what was cut and `nextLine` where to resume; `missingLines` lists lines no chunk covered |
| `GET` | `/api/v1/projects/:idOrSlug/stats` | scoped | Counts: files, symbols, chunks, commits, failures, languages, plus `failedFileDetail` — the most recently updated failed files, with path and error |
| `GET` | `/api/v1/projects/:idOrSlug/index-status` | scoped | Vectors, failed files, active/last job, embedding config |
| `GET` | `/api/v1/projects/:idOrSlug/commits` | scoped | Commit history, newest first. `limit` (1–100, default 25), `before` (opaque keyset cursor: the `nextBefore` from a previous response, an ISO-8601 timestamp and a sha joined by `|`) for pagination; a bare ISO-8601 timestamp is still accepted for compatibility but is lossy, skipping commits that share its exact instant. Returns `nextBefore` (`null` on the last page) plus the repository's `branch`/`lastKnownCommit`/`syncStatus`/`lastSuccessfulSync` |
| `GET` | `/api/v1/projects/:idOrSlug/graph` | scoped | Call/import/extends graph around one symbol. `root` (**required**), `depth` (1–4, default 2), `limit` (1–1000, default 200). `found: false` means the root symbol is not in the index — distinct from a symbol that genuinely has no edges |
| `GET` | `/api/v1/projects/:idOrSlug/evals` | scoped | Stored eval questions scored live against the index. `limit` (results per question, 1–50, default 10). At most 4 questions are scored per request; the response reports `scored`, `total` and `notScored` so a partial run is never read as a complete one. Per question: `recallFiles` at k=5,10, a `contextHitRate` that is **always `null` here** (see [Retrieval quality](#retrieval-quality)), and `recallSymbols` **only for questions that name expected symbols** — the aggregate reports `symbolQuestions` so a symbol score is never read as covering questions that had no expectation |
| `POST` | `/api/v1/projects/:idOrSlug/evals` | scoped | `{ question, expectedFiles[] }` → 201 with the created row. `question` 3–500 chars, 1–25 expected paths, 500 questions per project |
| `DELETE` | `/api/v1/projects/:idOrSlug/evals?id=…` | scoped | Delete one question, scoped by project so one project cannot remove another's |
| `GET` | `/api/v1/projects/:idOrSlug/search` | scoped | `q`, `mode=hybrid\|lexical\|semantic\|symbol`, `limit`, `chunkTypes`, `languages`. An unrecognised `chunkTypes` value is a 400 `validation_failed` rather than being silently dropped, so a typo cannot turn a filtered search into an unfiltered one |
| `POST` | `/api/v1/projects/:idOrSlug/search/context` | scoped | `{ query, limit? }` → context bundle |
| `GET` | `/api/v1/projects/:idOrSlug/symbols` | scoped | Symbol search (`q`, `kind`, `language`, `limit`) |
| `GET` | `/api/v1/projects/:idOrSlug/symbols/:name/references` | scoped | Callers/usages of a symbol |
| `GET` | `/api/v1/projects/:idOrSlug/symbols/:name/dependencies` | scoped | A symbol's calls/imports/extends |
| `GET` | `/api/v1/projects/:idOrSlug/tests` | scoped | Test files for a `symbol` (optional) |
| `POST` | `/api/v1/projects/:idOrSlug/reindex` | scoped | `{ type: initial\|incremental\|full\|reembed }` → job id |
| `POST` | `/api/v1/projects/:idOrSlug/sync` | scoped | Refresh the repository workspace |
| `GET` | `/api/v1/projects/:idOrSlug/webhook` | scoped | Webhook URL + per-project secret |
| `GET` | `/api/v1/search` | scoped | Cross-project convenience: `project`, `q`, `mode`, `limit` |
| `POST` | `/api/v1/search/context` | scoped | `{ project, query, limit? }` → context bundle |
| `GET` | `/api/v1/jobs` | scoped | Job list (`project`, `status`, `type`, `limit`, `offset`) |
| `GET` | `/api/v1/jobs/:id` | scoped | Job detail |
| `POST` | `/api/v1/jobs/:id/cancel` | scoped | Cooperative cancellation |
| `POST` | `/api/v1/jobs/:id/retry` | scoped | Re-enqueue a failed/cancelled job |
| `GET` | `/api/v1/metrics` | any principal | Aggregated metric summaries + job status counts |
| `GET` / `POST` | `/api/v1/api-keys` | session | List; create machine credential (plaintext shown once). Both refuse an `api_key` principal — including an unscoped owner-level one — so a leaked machine credential cannot enumerate or mint further keys |
| `DELETE` | `/api/v1/api-keys/:id` | session | Revoke a key. Idempotent: revoking an already-revoked key succeeds with `alreadyRevoked: true`; only an unknown id is a 404 |
| `GET` / `POST` | `/api/auth/*` | public | Better Auth handler: register, login, logout, password reset. Reset paths answer 503 when no mail transport is configured |
| `POST` | `/api/v1/webhooks/github` | signature | GitHub push → incremental index. This is the only webhook entry point; there is no unversioned `/api/webhooks/` route |
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

Point any MCP client (Claude, etc.) at `http://localhost:3000/mcp` with the same bearer token. Fifteen tools, every one project-scoped: `list_projects`, `search_code`, `search_docs`, `find_symbol`, `find_references`, `find_dependencies`, `find_tests`, `get_file`, `get_file_outline`, `get_file_range`, `get_dependency_graph`, `list_commits`, `get_project`, `get_index_status`, `get_context`.

## Evaluation

The offline eval harness replays the exact search the API serves against question sets in `data/evals/*.json` and scores retrieval:

```bash
npm run eval                                # all questions, all projects
npm run eval -- --project order-service     # one project
npm run eval -- --limit 20                  # fetch 20 results per question (default 10, max 50)
npm run eval -- --json                      # machine-readable report
npm run eval -- --floor 0.5                 # recall@10 floor (default 0.5)
```

Each question is `{ id, projectSlug, query, mode?, expectedFiles, expectedSymbols?, notes? }`. The runner computes file/symbol **recall@5 and recall@10** from `searchProject`, a **context-bundle hit rate** from `buildContextBundle`, prints a per-question + aggregate table, and exits non-zero when aggregate file recall@10 falls below the floor (or when any question fails to run). For clean piped JSON use `npx tsx scripts/eval.ts --json`.

**There is no seed question set in the repository.** `/data/` is gitignored, so a fresh clone has no `data/evals/` directory and `npm run eval` exits 1 with `No questions found in data/evals`. Author your own:

```bash
mkdir -p data/evals
$EDITOR data/evals/my-questions.json       # { "questions": [ { "id", "projectSlug", "query", "expectedFiles", … } ] }
```

`projectSlug` must match a project that already exists in the database (a question naming a missing project is recorded as a per-question failure, `project "<slug>" not found`, and makes the run exit non-zero), and `expectedFiles` are repo-relative paths in *that* repository. A worked example used to ship as `data/evals/sample.json` against a fixture repo at `data/test-repos/rt-test-repo`; neither is in version control, so the questions you write have to be about a repository you indexed yourself. To skip the files entirely, add questions to a running instance through `POST /api/v1/projects/:idOrSlug/evals` and read them back with `GET` — that path scores the same questions, minus the context bundle (see [Retrieval quality](#retrieval-quality)).

The scoring code lives in `src/lib/eval/recall.ts` and is shared with the eval API — see below.

## Retrieval quality

A search index that returns nothing plausible still "works" in the sense that every request returns 200. The only way to know whether it is finding the *right* code is to ask it questions whose answers you already know and measure how often the right file comes back.

**recall@k** is that measurement. For a question with a set of expected files, run the normal search, take the top *k* results, and compute

```
recall@k = |expected files present in the top k| / |expected files|
```

It is a per-question fraction, averaged across questions. `recall@10 = 0.8` means: across every question, four out of five of the files you said were relevant actually showed up in the top ten. It is deliberately not a ranking metric — a result that appears at position 47 counts the same as one at position 1, which is why k=5 and k=10 are both reported. Recall going up while you reorder the UI is a normal result, not a regression.

Symbols are scored separately with a looser rule (`symbolHitAt`): a result counts as a hit if its symbol *is* the expected symbol or is one of its members or its parent, because "the method inside the class you asked about" is a correct answer to a question about the class.

**Adding a question.** The CLI reads `data/evals/*.json` from disk (create the directory and the files yourself — nothing is committed there). The dashboard and the API keep questions in the `eval_question` table, so a running instance can be given new ones without a redeploy:

```bash
curl -s -X POST http://localhost:3000/api/v1/projects/order-service/evals \
  -H "Cookie: <session>" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "where does order expiry get scheduled?",
    "expectedFiles": ["src/orders/expiry.ts"]
  }'
```

- `question` — the text handed to search, 3–500 characters.
- `expectedFiles` — repo-relative paths, 1–25 of them. `./` prefixes are normalised away on both sides, so `./src/a.ts` and `src/a.ts` are the same answer.

`GET /api/v1/projects/:idOrSlug/evals?limit=10` runs the stored questions against the **live** index right now — it is not reading a cached score — and returns per-question `recallFiles`/`recallSymbols` at k=5 and 10 plus the aggregate. Its `contextHitRate` is **always `null`**, on every question and in the aggregate: the route calls `evaluateQuestion` without the `withContext` flag, and nothing on the HTTP surface sets it. Only the offline harness passes it (`scripts/eval.ts`), because a context bundle costs roughly six extra index round trips per question and this route scores up to 50 questions per request. So read the two surfaces as: this endpoint reports **file and symbol recall only**; the context hit rate comes from `npm run eval`. `DELETE /api/v1/projects/:idOrSlug/evals?id=…` removes one.

The project page's **Retrieval** tab renders exactly this. It calls the same `recallAt`/`symbolHitAt`/`aggregateResults` the CLI calls, over the same `searchProject` the API serves — `src/lib/eval/recall.ts` is the single implementation, and the dashboard, the REST endpoint and `npm run eval` cannot disagree about a **recall** number. What differs is the source of the questions (the CLI reads JSON files, the API reads the table) and the context bundle: the tab is a client component reading the endpoint above, so its context hit rate is `null` for the same reason, while the CLI reports a real one.

Two limits worth knowing: `GET` scores at most 50 questions per request (it sets `truncated` if more exist, and re-scoring is a real search per question), and the deterministic mock embedding provider makes semantic scores close to noise, so treat hybrid recall as a floor until you point it at a real embedding endpoint.

## Testing

```bash
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint
npm test                       # vitest run
```

Vitest runs the unit suite in `tests/`. The integration suite in `tests/integration/` needs live Postgres, Qdrant and Redis; it is skipped unless `RUN_INTEGRATION=1` is set, so the default run stays hermetic:

```bash
npm test                                  # unit suite
RUN_INTEGRATION=1 npm test                # also runs tests/integration (needs the compose stack)
```

The unit suite needs no fixtures. The integration suite additionally clones a fixture repository from `data/test-repos/rt-test-repo` (`tests/helpers.ts`), which `/data/` being gitignored means a fresh clone does not have — provide a repository at that path, or expect those two files to fail before they reach a database.

CI runs lint, typecheck, the unit suite and a Prisma client/schema consistency check on every push and pull request; the Docker image is only built once all four pass.

## Project layout

```
src/
  app/
    api/v1/…        REST API route handlers (projects, search, graph, commits, evals, jobs, api-keys, webhooks, metrics, health)
    api/auth/       Better Auth handler (register/login/logout/reset)
    mcp/            MCP streamable-HTTP transport
    (dashboard)/    dashboard pages (overview, projects, search, jobs, embeddings, health, settings)
    (auth)/         login / signup / forgot + reset password
  lib/
    search/         hybrid, lexical, semantic, structural search + context bundles
    indexing/       pipeline, tree-sitter parser, language registry
    embedding/      OpenAI-compatible provider (batching, retries)
    eval/           recall@k scoring shared by the CLI harness and the eval API
    git/            git CLI wrapper + workspaces
    github/         webhook signature validation
    jobs/           BullMQ queue
    mcp/            MCP tool registry
    projects/       project lifecycle
    api/, http.ts, errors.ts   route() wrapper, zod → AppError mapping, project-scoping guard
  worker/           BullMQ worker (indexing, sync, delete jobs)
  components/       shadcn/ui components + dashboard widgets
  generated/prisma/ generated Prisma client (committed; regenerate with `npm run db:generate`)
scripts/
  eval.ts           offline retrieval evaluation
  mock-embeddings.mjs   deterministic OpenAI-compatible mock
data/                (gitignored — created by you, ships nothing)
  evals/            question sets for the eval harness; `npm run eval` reads *.json here
  workspaces/       clone working dirs, created on demand by the worker
prisma/             schema + migrations
tests/              unit suite (hermetic) + tests/integration (needs the compose stack)
Dockerfile          multi-stage image (app + worker)
docker-compose.yml  postgres / qdrant / redis / app / worker
```

## Docker image notes

`npm run start` (`next start`) and the worker (`tsx src/worker/index.ts`) share one image built from `./Dockerfile`. The runtime stage keeps the source tree + config because the worker is runtime-compiled by `tsx`. It installs `git` (the indexer shells out to the git CLI) and uses `npm ci --omit=dev` for prod-only dependencies. Tree-sitter grammars ship prebuilt native binaries for `linux-x64`/`linux-arm64`; they require glibc (provided by the `node:24-bookworm-slim` base) and no extra build toolchain. Health is surfaced at `/api/v1/health` — a public, cheap liveness probe suitable for a container healthcheck, returning 503 when a core dependency is down. The detailed view, which includes a live embedding-API probe, is at `/api/v1/health/status` and requires auth.

## Generated Prisma client

`prisma/schema.prisma` declares `output = "../src/generated/prisma"`, and the generated client is **committed to the repository** (23 files under `src/generated/prisma/`). That is a deliberate trade: the Docker build compiles the app and the worker from source with no `prisma generate` step, and nothing in `package.json` runs one on `postinstall`, so the build depends on the checked-in client being current.

The cost is that a schema edit can be committed without regenerating, and the stale client then typechecks and ships — the failure surfaces as a runtime `PrismaClientValidationError` against a column that exists in the database but not in the client, not as a build error. CI guards this: the `check` job regenerates the client from the schema and fails if the result differs from what is committed, so a schema change cannot ship a stale client.

```bash
npm run db:generate    # after every edit to prisma/schema.prisma
```

`npx prisma validate` alone does **not** catch this. It checks that the schema is well-formed and that the generator block is sane; it never looks at the generated output. It is used in CI as the cheap first gate because it needs no database and no generator run.
