# Code Intelligence Platform — V1

## 0. Objective

Build a self-hosted, centralized code-intelligence platform whose sole purpose is to index multiple software repositories and provide fast, high-quality semantic, lexical, and structural code retrieval to AI coding agents.

The platform must be reusable across arbitrary repositories. A repository is configuration/data, NOT a separate application.

The system must provide:

* Git repository registration
* Automatic repository synchronization
* Incremental indexing
* AST/symbol-aware code chunking
* Remote embedding generation through configurable embedding APIs
* Vector storage in Qdrant
* Lexical search
* Symbol/reference/dependency search
* Hybrid retrieval
* Result reranking
* Project-aware search
* MCP access for AI coding agents
* REST API
* Web dashboard
* Email/password authentication using Better Auth
* Job management and observability
* Multi-project isolation
* Persistent indexing state
* Embedding model/version management

The platform is intended primarily for private personal/internal use, but its architecture should not prevent future multi-user support.

---

# 1. Non-Goals

V1 must NOT attempt to become:

* A GitHub replacement
* A full IDE
* A code editor
* A CI/CD system
* A general-purpose RAG platform
* An autonomous coding agent
* A source-code hosting service
* A deployment platform

The system's job is:

> **Understand, index, retrieve, and expose codebase knowledge to AI agents.**

Do not add unrelated SaaS functionality.

---

# 2. Core Architecture

Use a modular architecture:

```text
                         ┌──────────────────────┐
                         │      Next.js App     │
                         │    shadcn/ui UI      │
                         └──────────┬───────────┘
                                    │
                              authenticated API
                                    │
                         ┌──────────▼───────────┐
                         │     Application API  │
                         └──────────┬───────────┘
                                    │
             ┌──────────────────────┼──────────────────────┐
             │                      │                      │
             ▼                      ▼                      ▼
        PostgreSQL               Qdrant              Job Queue
       metadata/state          vector storage        background work
             │                      │                      │
             └──────────────────────┼──────────────────────┘
                                    │
                           ┌────────▼────────┐
                           │ Worker Pipeline │
                           └────────┬────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
             Git Sync           Parser/AST          Embeddings
                │                   │                   │
                └───────────────────┼───────────────────┘
                                    │
                                    ▼
                               Qdrant index
```

The exact internal implementation language/framework may be chosen based on project requirements, but the architecture must preserve these logical boundaries.

---

# 3. Technology Requirements

## Frontend

Use:

* Next.js
* React
* TypeScript
* shadcn/ui
* Tailwind CSS

The dashboard must use shadcn/ui components rather than introducing another component library.

Preferred components include:

* Sidebar
* Card
* Table
* Badge
* Tabs
* Command
* Dialog
* Sheet
* DropdownMenu
* Select
* Tooltip
* Progress
* Skeleton
* Alert
* Charts
* Pagination

The UI should feel like a serious developer/infrastructure tool.

Do NOT create:

* flashy AI gradients
* excessive animations
* generic SaaS landing-page styling
* oversized cards
* unnecessary decoration

Prioritize information density, readability, speed, and developer ergonomics.

---

# 4. Authentication

Use Better Auth.

V1 authentication requirements:

* email/password registration
* email/password login
* logout
* session management
* password change
* password reset
* protected dashboard routes

Do NOT implement OAuth providers, SSO, organizations, complex RBAC, or social login in V1.

Human dashboard authentication and machine/agent authentication must be separate.

Human:

```text
Browser
  ↓
Better Auth session
  ↓
Dashboard/API
```

Agent:

```text
MCP/API client
  ↓
API key / machine credential
  ↓
API/MCP
```

Never require an AI agent to authenticate using a browser session.

---

# 5. PostgreSQL Responsibilities

PostgreSQL is the source of truth for application metadata and state.

Store at minimum:

## Users

* id
* email
* Better Auth-managed authentication data
* timestamps

## Projects

* id
* name
* slug
* description
* repository URL
* provider
* default branch
* indexing status
* created_at
* updated_at

## Repositories

* project_id
* provider
* URL
* branch
* credentials/reference
* last known commit
* last successful sync
* sync status

Never store plaintext repository credentials.

## Files

* project_id
* repository_id
* path
* language
* hash
* size
* last indexed commit
* status

## Symbols

* project_id
* file_id
* symbol name
* qualified name
* symbol type
* language
* start line
* end line
* parent symbol
* metadata

## Chunks

* project_id
* file_id
* symbol_id where applicable
* content hash
* chunk type
* source location
* embedding model/version
* indexing state

## Commits

* repository_id
* SHA
* author
* message
* timestamp

## Jobs

* id
* project_id
* type
* status
* progress
* error
* started_at
* completed_at
* metadata

## API credentials

Store hashed/revocable credentials for machine access.

---

# 6. Qdrant

Use Qdrant for vector storage.

Qdrant must NOT become the primary relational database.

Vectors should contain rich payload metadata.

Example:

```json
{
  "project_id": "...",
  "file_id": "...",
  "path": "src/orders/service.ts",
  "symbol": "OrderService.cancelOrder",
  "kind": "method",
  "language": "typescript",
  "module": "orders",
  "start_line": 142,
  "end_line": 188,
  "content_hash": "...",
  "embedding_model": "...",
  "embedding_version": 1,
  "content": "..."
}
```

Design collections/tenancy so projects cannot accidentally retrieve one another's private code.

---

# 7. Repository Integration

V1 should support Git repositories.

Prioritize GitHub first.

Architecture should allow future providers:

* GitHub
* GitLab
* Bitbucket
* generic Git repositories

A project registration must include:

```text
Project name
Repository URL
Provider
Branch
Authentication configuration
```

After registration, the system must clone/synchronize the repository into an isolated workspace.

Repository contents are temporary indexing material and should not be treated as the authoritative database.

---

# 8. GitHub Webhooks

Implement webhook-driven incremental indexing.

Flow:

```text
GitHub push
    ↓
Webhook endpoint
    ↓
Validate signature
    ↓
Determine project
    ↓
Create indexing job
    ↓
Worker
    ↓
Fetch changed commit
    ↓
Determine changed files
    ↓
Re-index only affected content
```

Do not re-index the entire repository after every commit.

Provide a manual:

```text
Re-index Project
```

operation for administrators.

---

# 9. Indexing Pipeline

The indexing pipeline is:

```text
Repository
    ↓
Git synchronization
    ↓
Changed-file detection
    ↓
Language detection
    ↓
Parsing
    ↓
AST/symbol extraction
    ↓
Semantic chunking
    ↓
Metadata generation
    ↓
Embedding generation
    ↓
Qdrant upsert
    ↓
PostgreSQL state update
```

The pipeline must be incremental.

If one function changes, do not unnecessarily re-embed unrelated functions.

---

# 10. Code Chunking

Do NOT simply split source files every N tokens.

Prefer semantic units.

Possible chunks:

* functions
* methods
* classes
* interfaces
* types
* enums
* modules
* routes
* SQL queries
* configuration blocks
* tests
* documentation sections

Every chunk must retain source location metadata.

Example:

```text
src/orders/service.ts
OrderService.cancelOrder()
lines 142-188
```

For languages without high-quality AST support, provide a fallback chunking strategy.

Never allow unsupported languages to crash an entire indexing job.

---

# 11. AST / Symbol Index

Build a structural index independently from embeddings.

The system should understand relationships such as:

```text
calls
imports
references
implements
extends
tests
routes_to
reads_from
writes_to
```

The exact implementation may use Tree-sitter, language servers, compiler APIs, or other appropriate parsers.

The architecture must not make semantic vector search responsible for exact code relationships.

---

# 12. Embeddings

Embedding generation must use configurable external embedding APIs.

V1 should support OpenAI-compatible or otherwise configurable embedding endpoints where practical.

The embedding model must be configurable per project/index.

Do not hardcode one provider.

Store:

```text
provider
model
dimension
version
```

with every index configuration.

The platform is expected to use small 1–3B-class embedding models hosted remotely.

Embedding generation must support batching.

Example:

```text
100 chunks
    ↓
single/batched embedding request
    ↓
100 vectors
    ↓
Qdrant batch upsert
```

Do not make one network request per chunk.

---

# 13. Embedding Versioning

Embeddings must be versioned.

Example:

```text
model = provider/model-name
version = 3
dimension = 1024
```

Changing the embedding model must NOT silently mix incompatible vectors.

The UI must show:

* current model
* dimension
* indexed chunk count
* embedding version
* indexing progress

Support future full re-embedding jobs.

---

# 14. Search System

Implement three retrieval mechanisms.

## A. Lexical

Use PostgreSQL full-text search, BM25, Tantivy, or another appropriate lexical engine.

Useful for:

```text
OrderService
cancelOrder
ReservationStatus
specific error messages
file paths
identifiers
```

## B. Semantic

Use Qdrant vector similarity.

Useful for:

```text
"where do we handle expired reservations?"
```

## C. Structural

Use the symbol/dependency index.

Useful for:

```text
references to OrderService.cancelOrder
callers of FooService
tests for PaymentService
imports of module X
```

---

# 15. Hybrid Retrieval

Never rely exclusively on vector search.

The retrieval pipeline should be:

```text
Query
  │
  ├── lexical search
  ├── vector search
  └── symbol/structural search
          │
          ▼
       merge
          │
          ▼
       rerank
          │
          ▼
    final context set
```

Search results must preserve provenance:

```text
vector
lexical
symbol
structural
```

This should be visible in the API and optionally in the dashboard.

---

# 16. Reranking

Design retrieval so a reranking stage can be added.

V1 may use a lightweight/local/provider reranker or a deterministic scoring strategy.

The architecture must not hardcode retrieval results directly into the final response.

The system should be able to evolve from:

```text
vector score
```

to:

```text
hybrid score
+
reranker score
+
structural relevance
```

without rewriting the entire search system.

---

# 17. Context Bundles

The primary output of retrieval should be a context bundle.

Example:

```text
Query:
"How does order pickup expiration work?"

Relevant symbols:
- PickupReservation.expire()
- OrderService.cancel()
- NotificationService.notifyPickupExpiring()

Relevant tests:
- pickup-expiry.test.ts

Relevant documentation:
- docs/ai/FLOWS.md

Relevant relationships:
- PickupReservation → OrderService
- OrderService → NotificationService
```

The agent should receive this curated context rather than raw database results.

---

# 18. MCP

Implement MCP access.

The MCP server must expose tools conceptually equivalent to:

```text
search_code
find_symbol
find_references
find_dependencies
find_tests
search_docs
get_file
get_project
get_index_status
```

Example:

```text
search_code(
    project="darfat",
    query="how are expired reservations handled?"
)
```

The MCP layer must enforce project access.

Agents must never be able to omit the project/tenant context when it is necessary to prevent cross-project leakage.

---

# 19. REST API

Expose an authenticated API for:

* project CRUD
* repository configuration
* indexing jobs
* search
* symbol lookup
* references
* dependencies
* tests
* index status
* embedding configuration
* MCP authentication
* system health

Use typed request/response schemas.

Validate all external input.

---

# 20. Dashboard

Create a polished shadcn/ui dashboard.

## Sidebar

```text
Overview

Projects
  All Projects

Indexing
  Jobs
  Queue

Search

Embeddings

System
  Health
  Settings
```

## Overview

Display:

```text
Projects
Vectors
Chunks
Files
Symbols
Active Jobs
Failed Jobs
```

Also show recent activity.

---

# 21. Project Dashboard

For every project:

```text
Project Name

Overview
Search
Files
Symbols
Jobs
Settings
```

Show:

```text
Files
Chunks
Vectors
Symbols
Languages
Last commit
Last indexed
Current index status
Embedding model
```

Provide:

```text
[Search]
[Re-index]
[Settings]
```

---

# 22. Search UI

Search must be a first-class dashboard feature.

Provide:

```text
┌──────────────────────────────────────────────┐
│ Search code, symbols, docs...                │
└──────────────────────────────────────────────┘
```

Filters:

```text
Project
Language
File type
Code / Tests / Docs
Symbol type
```

Results should show:

```text
OrderService.cancelOrder()
src/orders/service.ts:142

Similarity: 0.91

Relevant code preview...

[Open]
[References]
[Dependencies]
[Tests]
```

Display retrieval source:

```text
Vector
Lexical
Symbol
Hybrid
```

---

# 23. Global Command Palette

Implement shadcn Command-based global search.

Shortcut:

```text
Cmd/Ctrl + K
```

Allow:

```text
Search code
Search projects
Search symbols
Open project
View jobs
View system health
```

---

# 24. Jobs

All long-running operations must be jobs.

Examples:

```text
initial_index
incremental_index
full_reindex
reembed
repository_sync
delete_project
```

Jobs must support:

```text
queued
running
completed
failed
cancelled
```

Track:

```text
progress
current stage
files processed
chunks processed
embeddings generated
vectors written
errors
duration
```

The dashboard must show live job status.

---

# 25. Worker Architecture

Workers must be separate from the web process.

Do not run large indexing operations inside HTTP request handlers.

Conceptually:

```text
API
 ↓
enqueue job
 ↓
queue
 ↓
worker
 ↓
index
```

Workers should be horizontally scalable.

A failed job must be retryable.

Jobs should be idempotent wherever possible.

---

# 26. Incremental Indexing

Use content hashes.

For every source unit:

```text
content
 ↓
hash
```

If hash is unchanged:

```text
DO NOTHING
```

If changed:

```text
delete/replace previous chunk
embed new chunk
update Qdrant
update PostgreSQL
```

Removed files/symbols must also be removed from the index.

---

# 27. Code History

Optionally index useful Git metadata.

At minimum retain:

* commit SHA
* commit message
* author
* timestamp

Design the system so important commit messages/diffs can later become searchable semantic documents.

This allows future queries such as:

```text
"Why does this retry mechanism exist?"
```

to potentially retrieve historical context.

Do not make Git-history indexing mandatory for initial V1 indexing unless it is straightforward.

---

# 28. Security

Treat indexed source code as highly sensitive.

Requirements:

* HTTPS
* secure authentication
* secure session cookies
* CSRF protection where applicable
* webhook signature validation
* API key hashing
* secrets stored securely
* repository credentials encrypted or delegated to provider integrations
* strict project-level authorization
* Qdrant access never exposed publicly
* PostgreSQL access never exposed publicly
* workers isolated from the public internet where practical
* no source-code logging
* no embedding payload logging
* configurable retention for temporary repository workspaces

Never log entire source files.

Never log embedding request bodies.

---

# 29. External Embedding Provider Privacy

Embedding providers may receive source-code content.

The application must treat embedding providers as configurable external processors.

Provider configuration must be explicit.

Do not assume a provider is privacy-safe.

Allow the administrator to configure:

```text
provider
endpoint
API key
model
dimensions
batch size
```

The administrator has chosen providers whose relevant embedding endpoints provide zero-data-retention according to their applicable policies.

Do not silently send source code to a different provider.

---

# 30. Project Isolation

Every resource must be associated with a project.

At minimum:

```text
project_id
```

must exist throughout:

```text
files
symbols
chunks
vectors
jobs
search
MCP
API
```

A request for Project A must never retrieve Project B.

Treat this as a critical security invariant.

---

# 31. Observability

Provide a system health page.

Show:

```text
PostgreSQL       ● Healthy
Qdrant           ● Healthy
Job Queue        ● Healthy
Embedding API    ● Healthy
Repository Sync  ● Healthy
Workers          ● 3 active
```

Track:

* indexing duration
* embedding latency
* embedding failures
* Qdrant latency
* search latency
* job failures
* queue depth

Avoid storing source code in logs.

---

# 32. Error Handling

An individual malformed file must not destroy an entire repository index.

Example:

```text
Repository
  ├── 10,000 valid files
  └── 3 parser failures
```

Result:

```text
Index completes
10,000 indexed
3 failed
```

The dashboard must expose failed files and their errors.

---

# 33. Configuration

All infrastructure configuration must use environment variables/secrets.

Examples:

```text
DATABASE_URL
QDRANT_URL
QDRANT_API_KEY

BETTER_AUTH_SECRET
BETTER_AUTH_URL

GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_WEBHOOK_SECRET

EMBEDDING_PROVIDER
EMBEDDING_API_URL
EMBEDDING_API_KEY
EMBEDDING_MODEL
EMBEDDING_DIMENSIONS
```

Never commit secrets.

Provide `.env.example`.

---

# 34. Developer Experience

Provide:

```text
README.md
.env.example
docker-compose.yml
database migrations
seed/setup instructions
```

Local development must be straightforward.

A developer should be able to:

```text
git clone
install dependencies
configure .env
start PostgreSQL
start Qdrant
start workers
start Next.js
```

and access the dashboard.

---

# 35. API Design

Use strong schemas throughout.

Recommended:

* Zod for TypeScript validation
* typed API contracts
* strict TypeScript
* consistent error format

Never trust:

* query parameters
* request bodies
* webhook payloads
* repository metadata
* MCP arguments
* API keys

---

# 36. Testing

Implement tests for:

## Authentication

* registration
* login
* logout
* protected routes
* password reset

## Projects

* create
* update
* delete
* authorization

## Indexing

* initial indexing
* incremental indexing
* unchanged files
* changed files
* deleted files
* parser failure
* embedding failure
* Qdrant failure
* retry behavior

## Search

* lexical
* semantic
* hybrid
* project isolation
* symbol search
* reference search

## Webhooks

* valid signature
* invalid signature
* duplicate webhook
* changed commit

## MCP

* authentication
* project isolation
* search
* symbol retrieval

---

# 37. Retrieval Evaluation

Create an internal retrieval evaluation dataset.

For each project, maintain representative questions:

```text
"Where is authentication handled?"
"Where are expired reservations processed?"
"Which service sends order notifications?"
"Where is payment state changed?"
"Who calls OrderService.cancel()?"
```

Record expected relevant files/symbols.

Measure:

```text
Recall@5
Recall@10
Recall@20
```

Use this to compare:

* embedding models
* chunking strategies
* hybrid weighting
* rerankers

Do not assume the biggest embedding model is automatically best.

---

# 38. Architecture Principles

Follow these principles throughout implementation:

1. Retrieval quality matters more than raw vector count.
2. Semantic search complements, rather than replaces, lexical and structural search.
3. PostgreSQL is relational source of truth.
4. Qdrant is vector retrieval infrastructure.
5. Workers perform expensive operations.
6. HTTP handlers remain fast.
7. Index incrementally.
8. Never reprocess unchanged content.
9. Every project is isolated.
10. Everything important is observable.
11. Prefer simple infrastructure until scale requires complexity.
12. Do not build features that aren't required by the core mission.

---

# 39. Agent/AI Development Rules

When implementing this specification, the coding agent must:

* inspect the repository before making architectural assumptions
* create a clear implementation plan
* implement in small verifiable stages
* avoid unrelated refactors
* reuse existing utilities when appropriate
* run typechecking
* run linting
* run tests
* inspect the final diff
* fix errors before declaring completion

Do not generate fake implementations or placeholder functionality and mark it complete.

If an external dependency's API is uncertain, consult its current documentation rather than guessing.

Do not silently substitute technologies specified in this document.

---

# 40. Implementation Order

Implement in this order:

### Phase 1 — Foundation

* project structure
* configuration
* PostgreSQL
* migrations
* Better Auth
* basic Next.js application
* shadcn/ui setup
* dashboard shell

### Phase 2 — Projects

* project CRUD
* repository configuration
* project dashboard
* project authorization

### Phase 3 — Git

* repository synchronization
* GitHub integration
* webhook processing
* commit tracking

### Phase 4 — Indexer

* file discovery
* language detection
* AST parsing
* symbol extraction
* semantic chunking
* incremental hashing

### Phase 5 — Embeddings

* provider abstraction
* batching
* model configuration
* embedding versioning
* Qdrant integration

### Phase 6 — Search

* lexical search
* vector search
* symbol search
* reference search
* dependency search
* hybrid retrieval
* reranking abstraction

### Phase 7 — Jobs

* queue
* workers
* progress tracking
* retries
* cancellation
* failure handling

### Phase 8 — Dashboard

* project metrics
* indexing jobs
* search interface
* embedding configuration
* health dashboard
* system metrics

### Phase 9 — MCP

* MCP server
* authentication
* project-aware tools
* search tools
* symbol/reference/dependency tools

### Phase 10 — Hardening

* security audit
* project-isolation tests
* failure testing
* retrieval evaluation
* performance testing
* documentation
* production deployment

---

# 41. V1 Acceptance Criteria

V1 is complete when all of the following work:

1. User can register/login using email/password.
2. User can create a project.
3. User can connect a GitHub repository.
4. Repository can be synchronized.
5. Repository can be indexed.
6. Code is semantically chunked.
7. Chunks are embedded through the configured embedding provider.
8. Vectors are stored in Qdrant.
9. Metadata is stored in PostgreSQL.
10. Incremental commits only re-index changed content.
11. Deleted files disappear from search.
12. User can perform lexical searches.
13. User can perform semantic searches.
14. User can search symbols.
15. User can retrieve references/dependencies.
16. Hybrid retrieval works.
17. Jobs show progress and failures.
18. Dashboard displays project/index health.
19. MCP clients can search the project.
20. Project isolation is enforced.
21. No source code is unnecessarily written to logs.
22. Tests cover critical indexing/search/auth flows.
23. The entire platform works for multiple repositories without modifying application code for each repository.

---

# 42. Final Product Philosophy

The final product should feel like:

> **A private, centralized search engine and knowledge layer for every codebase I own.**

The developer should be able to connect a repository once and forget about the infrastructure.

AI agents should be able to ask:

```text
"What code is relevant to this task?"
"Where is this symbol defined?"
"What calls this?"
"What tests cover this?"
"How does this subsystem work?"
"Why does this weird code exist?"
```

and receive highly relevant, project-scoped context without needing to ingest the entire repository into their context window.

The platform should continuously maintain this knowledge as repositories evolve.

Do not optimize for impressive demos.

Optimize for:

**retrieval quality + correctness + incremental indexing + low latency + reliability + simple operation.**
