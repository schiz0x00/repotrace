# Spec status audit

Audit of `docs/spec.md` (V1) against the codebase as of 2026-09-20. Status: `done` / `partial` / `missing`, with the implementation location and notable deviations. Line numbers refer to the current working tree.

## Core architecture & technology (spec §2, §3)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Next.js + React + TS + Tailwind + shadcn/ui dashboard | done | `src/app`, `src/components/ui`, `components.json`, `tailwind` deps in `package.json` | shadcn component set present (card, table, badge, tabs, dialog, sheet, dropdown-menu, select, tooltip, progress, skeleton, alert, chart, pagination, command, sidebar). |
| Modular boundaries: App → API → PG/Qdrant/Queue → worker | done | `src/app/api/**`, `src/lib/**`, `src/worker/index.ts`, `docker-compose.yml` | Matches the spec's logical split. |
| Dashboard = serious dev tool (no flashy styling) | partial | `src/app/(dashboard)`, `src/components/ui` | Overview + projects pages exist; styling intent preserved. |

## Authentication (spec §4)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Email/password registration, login, logout | done | `src/lib/auth.ts`, `src/app/api/auth/[...all]/route.ts`, `src/app/(auth)/{login,signup}` | Better Auth email/password enabled. |
| Password change / reset | done | `src/lib/auth.ts` (`sendResetPassword`), `src/app/(auth)/{forgot-password,reset-password}` | SMTP optional; reset links logged to console in dev (`src/lib/mailer.ts`). |
| Session management / protected dashboard routes | done | `src/lib/authn.ts`, `src/app/(dashboard)/layout.tsx` | Session cookie principal. |
| Separate human vs machine credentials | done | `src/lib/api-keys.ts`, `src/lib/authn.ts`, `src/app/mcp/route.ts` | API keys (`rt_…`) hashed at rest; MCP is API-key only. |
| No OAuth/SSO/orgs/RBAC in V1 | done | — | Correctly absent. |

## PostgreSQL schema (spec §5)

All required tables exist: `user`, `session`, `account`, `verification`, `project`, `repository`, `file`, `symbol`, `chunk`, `commit`, `job`, `api_key` (+ `webhook_delivery`, `metric_event`, `eval_question`). `prisma/schema.prisma`. Repository credentials stored AES-256-GCM encrypted (`src/lib/encryption.ts`, `src/lib/git/workspace.ts`), never plaintext. **done.**

## Qdrant (spec §6)

Per-project collection `proj_<id>` with rich payloads (path, symbol, kind, language, lines, content hash, embedding model/version, content) and payload indexes on `file_id`/`embedding_version`/`embedding_model`/`chunk_type`. `src/lib/qdrant.ts`. Isolation is structural (separate collections), not filter-based. **done.**

## Repository integration (spec §7)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Provider abstraction (github/gitlab/bitbucket/generic) | done | `prisma/schema.prisma` (`ProjectProvider`), `src/lib/projects/service.ts` | Providers are labels; only `generic` clone path is exercised in tests/fixtures. |
| Registration incl. branch + auth config | done | `POST /api/v1/projects` | Credentials optional, encrypted. |
| Clone/sync into isolated workspace | done | `src/lib/git/git.ts`, `src/lib/git/workspace.ts` | Blobless clone, per-project dir, retention pruning. |

## GitHub webhooks (spec §8)

Signature validation (HMAC-SHA256, global or per-project derived secret), delivery-id dedup, branch filter, debounced incremental index job. `src/app/api/v1/webhooks/github/route.ts`, `src/lib/github/webhook.ts`. Manual re-index: `POST /api/v1/projects/:idOrSlug/reindex`. **done.**

## Indexing pipeline (spec §9, §10, §11)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Full pipeline: sync → change detection → parse → chunk → embed → upsert → PG | done | `src/lib/indexing/pipeline.ts` | Git-change diff when ancestry holds; hash-based full scan otherwise. |
| Incremental (content hashes, skip unchanged, delete removed) | done | `src/lib/indexing/pipeline.ts` (`processFile`, `deleteFileFromIndex`) | |
| Semantic chunking (per-declaration + fallback + markdown sections) | done | `src/lib/indexing/parser.ts` | Gap blocks max 150 lines; non-AST languages block-chunked. |
| Symbol index: calls/imports/extends + qualified names | done | `src/lib/indexing/parser.ts`, `src/lib/search/structural.ts` | |
| `implements` relationship | partial | `parser.ts` extracts it | Dropped at persist time — pipeline writes only `calls`/`imports`/`extends` (`pipeline.ts:375-379`). |
| `reads_from` / `writes_to` / `routes_to` relationships | missing | — | Not extracted anywhere. |
| Unsupported/malformed files never crash a job | done | `parser.ts` fallbacks | Per-file embed failures mark the file `failed` with the error. |
| Parse errors surfaced to the dashboard | partial | `parser.ts` returns `error`; `pipeline.ts` ignores it | Files that fall back to block chunking are marked `indexed` and the parse error is dropped — only *embedding* failures mark a file failed. |

## Embeddings (spec §12, §13)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Configurable OpenAI-compatible provider | done | `src/lib/embedding/provider.ts` | |
| Per-project config override | done | `project` table fields, `resolveEmbeddingConfig` | |
| Batching (one request per batch) + retries | done | `provider.ts` (`embedTexts`, `embedBatchWithRetry`) | 429/5xx retried with backoff. |
| Versioning: model/version/dimension stored, never mixed | done | `chunk` + Qdrant payload; `reembed` purges non-current versions (`pipeline.ts` `purgeOtherVersions`) | |
| UI shows model/dimension/version/counts | partial | `GET /api/v1/projects/:idOrSlug/index-status` returns them | No dedicated Embeddings page in the dashboard yet. |

## Search (spec §14, §15, §16)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Lexical (PG full-text) | done | `src/lib/search/lexical.ts` | **Gap:** `to_tsquery('simple', …)` throws on multi-token input; fallback is literal-substring `ILIKE`, so natural-language lexical queries return nothing (e.g. `where is notify imported`). Single identifiers work. |
| Semantic (Qdrant vector similarity) | done | `src/lib/search/semantic.ts` | |
| Structural: symbol / references / dependencies / tests | done | `src/lib/search/structural.ts` | `findReferences` is a JS scan over a 500-symbol fetch cap (documented `ponytail:` in code) — degrades past ~10k symbols. |
| Hybrid merge + rerank | done | `src/lib/search/hybrid.ts` | Weighted reciprocal-rank fusion, deterministic rerank, provenance on each result. |
| Provenance preserved in API | done | `SearchResponse.items[].provenance` | `sources` counts are result-item counts, not source-level retrieval counts. |
| Reranking seam | done | `hybrid.ts` (`rerank` in `mergeAndRerank`; SOURCE_WEIGHTS) | Deterministic scorer in place; provider reranker can slot into `mergeAndRerank`. |

## Context bundles (spec §17)

`buildContextBundle` in `src/lib/search/context.ts`: top symbols + related symbols + tests + docs + relationships, exposed via `POST /api/v1/projects/:idOrSlug/search/context`, `/api/v1/search/context`, and MCP `get_context`. **done.**

## MCP (spec §18)

Streamable HTTP at `/mcp` (`src/app/mcp/route.ts`), API-key only. Tools: `list_projects`, `search_code`, `search_docs`, `find_symbol`, `find_references`, `find_dependencies`, `find_tests`, `get_file`, `get_project`, `get_index_status`, `get_context` (`src/lib/mcp/server.ts`). Project access enforced per request; project-scoped keys are locked to their project. **done.**

## REST API (spec §19, §35)

Full surface implemented under `/api/v1/*` (projects, files, stats, index-status, search, context, symbols, references, dependencies, tests, reindex, sync, webhook config, jobs + cancel/retry, metrics, api-keys, health, github webhook). Zod validation on every body/query; consistent `{ error: { code, message } }` shape via `src/lib/http.ts` + `src/lib/errors.ts`. **done.**

## Dashboard (spec §20, §21, §22, §23)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Overview page (projects/vectors/chunks/files/symbols/jobs/metrics) | done | `src/app/(dashboard)/page.tsx` | |
| Projects list + create dialog | done | `src/app/(dashboard)/projects/page.tsx`, `src/components/dashboard/new-project-dialog.tsx` | |
| Per-project page (stats, index status, jobs, webhook config) | partial | `src/app/(dashboard)/projects/[slug]/page.tsx` | Page exists but imports `project-tabs`/`project-actions` components that are not yet written — dashboard is mid-construction. |
| Search UI with filters + provenance display | missing | — | Not built; search is API/MCP only. |
| Global command palette (Ctrl/Cmd+K) | done | `src/components/dashboard/command-palette.tsx` | Nav targets (`/search`, `/jobs`, `/embeddings`, `/health`, `/settings`) have no pages yet. |
| Embeddings / System Health / Settings pages | missing | — | Data available via API (`/index-status`, `/health`, `/metrics`). |

## Jobs & worker (spec §24, §25, §26)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| All long ops are jobs (6 types) | done | `src/lib/jobs/queue.ts`, `src/worker/index.ts` | |
| Statuses queued/running/completed/failed/cancelled | done | schema + worker | Cooperative cancellation via abort signal + DB marker. |
| Progress + stage | done | worker `markJob` | |
| Retries (exponential) + idempotency | done | BullMQ attempts/backoff; hash-based re-runs | |
| Track files/chunks/embeddings/vectors per job | partial | computed in `IndexResult` (`pipeline.ts`) | Returned to BullMQ but not persisted on the `job` row — not visible in the API. |
| Worker separate + horizontally scalable | done | `docker-compose.yml` worker service, `WORKER_CONCURRENCY` | |
| Live job status in dashboard | done | `jobs-table.tsx`, overview page | |

## Security (spec §28, §29, §30)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Session cookies httpOnly/sameSite/secure | done | `src/lib/auth.ts` (`USE_SECURE_COOKIES`) | |
| API keys hashed at rest | done | `src/lib/api-keys.ts` (SHA-256 + timing-safe compare) | |
| Repo credentials encrypted | done | `src/lib/encryption.ts` (AES-256-GCM) | |
| Webhook signature validation | done | `src/lib/github/webhook.ts` | |
| Strict project isolation (files/symbols/chunks/vectors/jobs/search/API/MCP) | done | `projectId` on all tables; `src/lib/api/guard.ts`, `src/lib/authn.ts`, per-project Qdrant collections | |
| Qdrant/PG never exposed publicly | done (deployment) | docker-compose exposes ports for dev | Operator responsibility in production. |
| No source-code / embedding-payload logging | done | embedding body never logged (`provider.ts`); route logging is status/message only | |
| CSRF protection | partial | sameSite=lax cookies | No explicit CSRF tokens; mutating endpoints rely on cookie policy. |
| Configurable workspace retention | done | `WORKSPACE_RETENTION_DAYS` | |
| External embedding provider treated as explicit processor | done | per-project provider config; no payload logging; health probe documents the endpoint | |

## Observability (spec §31, §32)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Health endpoint (PG/Qdrant/queue/embedding/sync/workers) | done | `GET /api/v1/health` | Requires auth — unusable by unauthenticated proxies/LB without a credential. |
| Metric events tracked | done | `src/lib/metrics.ts` | Latency, failures, queue depth. |
| Failed files exposed | done | `/files?status=failed`, `/stats` | Only *embedding* failures surface; parse-fallback errors are dropped (see indexing notes). |
| Health page in dashboard | missing | — | API exists; page doesn't. |

## Config & DX (spec §33, §34)

Env-validated config (`src/lib/env.ts`), `.env.example`, docker-compose, migrations, README. **done.**

## Testing & eval (spec §36, §37)

| Requirement | Status | Where | Notes |
|---|---|---|---|
| Test suites (auth/projects/indexing/search/webhooks/MCP) | missing | `tests/` does not exist; `npm test` = `vitest run` with no suites | Largest gap. |
| Retrieval evaluation dataset + harness | done | `scripts/eval.ts`, `data/evals/sample.json` | recall@5/@10 + context hit rate; per-project fixtures. `eval_question` table exists in the schema but is unused by the harness (only deleted on project delete). |

## Acceptance criteria (spec §41)

21 of 23 verifiable criteria hold in code (register/login, create/connect/sync/index project, semantic chunking, embedding, Qdrant, PG metadata, incremental re-index, deleted files removed, lexical/semantic/symbol search, references/dependencies, hybrid, job progress, MCP search, project isolation, no source logging, multi-repo by design). **#18** (dashboard shows project/index health) is partial; **#22** (tests cover critical flows) is missing.

## Top gaps (ranked)

1. **No automated tests** — spec §36 and acceptance criterion #22 are entirely unmet; `tests/` is absent and `npm test` has no suites. Highest-risk gap for an indexer + auth surface.
2. **Multi-word lexical search is broken** — `to_tsquery('simple', …)` throws on multi-token queries and the ILIKE fallback is a literal substring match (`src/lib/search/lexical.ts:68-88`), so natural-language lexical queries (`where is notify imported`) return nothing. Confirmed live via the eval harness (`notify-import` question scores 0).
3. **Parse failures are silently downgraded** — files whose grammar is missing (e.g. the `service.py` fixture is whole-file fallback-chunked with zero symbols) or whose AST parse fails are marked `indexed`; the parser's `error` field is dropped in `processFile` (`pipeline.ts:311`), so spec §32's "dashboard must expose failed files" only holds for embedding failures.
4. **Dashboard is mid-construction** — project detail page imports `project-tabs`/`project-actions` components that don't exist yet; no Search UI, no Health/Embeddings/Settings pages (spec §20-23, #18).
5. **Job telemetry is not persisted** — `IndexResult` (files/chunks/embeddings/vectors) is computed but never stored on the `job` row, so the API can't report per-job counters (spec §24).
6. **Structural index coverage** — `implements` is parsed but dropped at persist; `reads_from`/`writes_to`/`routes_to` are not implemented; `findReferences` runs a JS scan over a 500-symbol cap (spec §11).
7. **Health endpoint requires auth** — proxies/load balancers can't poll `/api/v1/health` unauthenticated, and the "workers" check infers liveness from job activity rather than a heartbeat (spec §31).
8. **CSRF** — no explicit CSRF tokens on session-authenticated mutating endpoints; only sameSite=lax cookies (spec §28).
9. **Mock-embedding noise** — with the deterministic hash-based mock provider, semantic retrieval is effectively random, so hybrid rankings lean on lexical+symbol. Expected for dev; real embedding endpoints are required for meaningful semantic eval comparisons (spec §37).