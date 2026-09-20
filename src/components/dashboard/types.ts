export interface RepositoryInfo {
  lastKnownCommit: string | null
  lastSuccessfulSync: string | null
  syncStatus: string | null
  syncError: string | null
  hasCredentials: boolean
}

export interface ProjectDto {
  id: string
  name: string
  slug: string
  description: string | null
  provider: string
  repoUrl: string
  defaultBranch: string
  status: string
  createdAt: string
  updatedAt: string
  embedding: {
    provider: string | null
    model: string | null
    dimensions: number | null
    batchSize: number | null
    version: number | null
  }
  repository: RepositoryInfo | null
  stats?: { projectId: string; files: number; symbols: number; chunks: number; activeJobs: number }
}

export interface JobDto {
  id: string
  projectId: string | null
  type: string
  status: string
  progress: number
  stage: string | null
  error: string | null
  attempts: number
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  project: { slug: string; name: string } | null
}

export interface MetricSummary {
  count: number
  sum: number
  avg: number
  min: number
  max: number
  p95: number
}

export interface MetricsResponse {
  metrics: Record<string, MetricSummary>
  jobs: Record<string, number>
  windowHours: number
}

export interface ProjectStats {
  files: number
  symbols: number
  chunks: number
  commits: number
  failedFiles: number
  activeJobs: number
  failedJobs: number
  languages: { language: string; count: number }[]
  lastKnownCommit: string | null
  lastSuccessfulSync: string | null
}

export interface IndexStatus {
  files: number
  symbols: number
  chunks: number
  vectors: number
  failedFiles: number
  embeddingModel: string | null
  embeddingDimensions: number | null
  embeddingVersion: number | null
  status: string
  lastIndexedCommit: string | null
  lastSuccessfulSync: string | null
  activeJob: JobDto | null
  lastJob: JobDto | null
}

export interface FileDto {
  id: string
  path: string
  language: string | null
  size: number
  status: string
  error: string | null
  lastIndexedCommit: string | null
  lastIndexedAt: string | null
  _count: { chunks: number; symbols: number }
}

export interface SymbolDto {
  id: string
  name: string
  qualifiedName: string
  kind: string
  language: string
  path: string
  startLine: number
  endLine: number
  parentName: string | null
}

export interface SearchResultItem {
  chunkId: string | null
  fileId: string
  path: string
  language: string
  symbol: string | null
  symbolKind: string | null
  startLine: number
  endLine: number
  content: string
  chunkType: string
  score: number
  hybridScore: number
  provenance: string[]
}

export interface SearchResponse {
  mode: string
  query: string
  project: { id: string; slug: string; name: string }
  items: SearchResultItem[]
  sources: { vector: number; lexical: number; symbol: number }
  tookMs: number
}

export interface HealthResponse {
  status: string
  checks: {
    postgres: { healthy: boolean; error?: string }
    qdrant: { healthy: boolean; version?: string; error?: string }
    queue: { healthy: boolean; depth: number; error?: string }
    embedding: { healthy: boolean; configured: boolean; httpStatus?: number; error?: string }
    repositorySync: { healthy: boolean; repositories: number; failures: number }
    workers: { activeJobs: number; recentCompleted: number; configuredConcurrency?: number }
  }
  version: string
  tookMs: number
}

export interface ApiKeyDto {
  id: string
  name: string
  keyPrefix: string
  projectId: string | null
  project: { slug: string; name: string } | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string | null
}

export interface WebhookInfo {
  url: string
  secret: string
  events: string[]
  contentType: string
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let v = bytes
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(1)} ${units[i]}`
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "—"
  const date = value instanceof Date ? value : new Date(value)
  const diff = Date.now() - date.getTime()
  const abs = Math.abs(diff)
  const suffix = diff >= 0 ? "ago" : "from now"
  const mins = Math.floor(abs / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ${suffix}`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${suffix}`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ${suffix}`
  return date.toLocaleDateString()
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—"
  const date = value instanceof Date ? value : new Date(value)
  return date.toLocaleString()
}

export function shortId(id: string, length = 8): string {
  return id.length > length ? id.slice(0, length) : id
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}