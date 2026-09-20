"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress, ProgressValue } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { JobsTable, jobTypeLabel } from "@/components/dashboard/jobs-table"
import { deleteProject, postAction } from "@/components/dashboard/project-actions"
import {
  FileCode2Icon,
  BracesIcon,
  BoxesIcon,
  GitCommitHorizontalIcon,
  CircleXIcon,
  Loader2Icon,
  SearchIcon,
  EyeIcon,
  EyeOffIcon,
  CopyIcon,
  Trash2Icon,
  TriangleAlertIcon,
  OctagonXIcon,
  CircleAlertIcon,
  RotateCcwIcon,
} from "lucide-react"
import type { FileDto, IndexStatus, JobDto, ProjectStats, SymbolDto, WebhookInfo } from "@/components/dashboard/types"
import { formatBytes, formatNumber, formatRelative } from "@/components/dashboard/types"

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    throw new Error((json as { error?: { message?: string } })?.error?.message ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

function PanelCard({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="p-0!">{children}</CardContent>
    </Card>
  )
}

function EmptyState({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
      {icon}
      <p className="text-sm">{children}</p>
    </div>
  )
}

const FILE_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  indexed: "outline",
  failed: "destructive",
  removed: "secondary",
}

const SYMBOL_KINDS = ["class", "function", "method", "variable", "constant", "interface", "struct", "enum", "type", "module", "namespace", "property", "field", "parameter", "import", "export"]


function OverviewTab({ stats, indexStatus, recentJobs }: { stats: ProjectStats; indexStatus: IndexStatus; recentJobs: JobDto[] }) {
  const cards = [
    { icon: <FileCode2Icon />, label: "Files", value: formatNumber(stats.files) },
    { icon: <BracesIcon />, label: "Symbols", value: formatNumber(stats.symbols) },
    { icon: <BoxesIcon />, label: "Chunks", value: formatNumber(stats.chunks) },
    { icon: <BoxesIcon />, label: "Vectors", value: indexStatus.vectors >= 0 ? formatNumber(indexStatus.vectors) : "n/a" },
    { icon: <GitCommitHorizontalIcon />, label: "Commits", value: formatNumber(stats.commits) },
  ]
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map(({ icon, label, value }) => (
          <Card key={label} className="flex-1!">
            <CardContent className="flex flex-col gap-1!">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</span>
              <span className="text-xl font-semibold tabular-nums">{value}</span>
            </CardContent>
          </Card>
        ))}
      </div>
      <PanelCard title="Languages">
        {stats.languages.length === 0 ? (
          <EmptyState icon={<FileCode2Icon />}>No files indexed yet.</EmptyState>
        ) : (
          <div className="flex flex-wrap gap-2 py-3">
            {stats.languages.map(({ language, count }) => (
              <Badge key={language} variant="outline">
                {language}
                <span className="text-muted-foreground">{count}</span>
              </Badge>
            ))}
          </div>
        )}
      </PanelCard>
      {stats.failedFiles > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{stats.failedFiles} file{stats.failedFiles === 1 ? "" : "s"} failed to index</AlertTitle>
          <AlertDescription>Check the Files tab for details and reindex when fixed.</AlertDescription>
        </Alert>
      )}
      <PanelCard title="Recent jobs">
        {recentJobs.length === 0 ? (
          <EmptyState icon={<CircleXIcon />}>No jobs yet.</EmptyState>
        ) : (
          <JobsTable jobs={recentJobs} showProject={false} />
        )}
      </PanelCard>
    </div>
  )
}


function FilesTab({ slug }: { slug: string }) {
  const [query, setQuery] = React.useState("")
  const [files, setFiles] = React.useState<FileDto[]>([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

const load = React.useCallback(
    async (page = 1) => {
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: "100" })
        if (query) params.set("path", query)
        const data = await getJson<{ files: FileDto[]; total: number }>(`/api/v1/projects/${slug}/files?${params}`)
        setFiles(data.files)
        setTotal(data.total)
        setError(null)
      } finally {
        setLoading(false)
      }
    },
    [slug, query],
  )

  const refresh = React.useCallback(
    (page = 1) => {
      setLoading(true)
      setError(null)
      return load(page).catch((err: Error) => setError(err.message))
    },
    [load],
  )

  React.useEffect(() => {
    void load(1)
  }, [load])

  return (
    <PanelCard
      title="Files"
      description={`${total} file${total === 1 ? "" : "s"} (showing up to 100)`}
      action={
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void refresh(1)
          }}
        >
          <Input
            placeholder="Filter by path…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-56!"
          />
        </form>
      }
    >
      {error && (
        <Alert variant="destructive" className="mx-3!">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && files.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span className="text-sm">Loading files…</span>
        </div>
      ) : files.length === 0 ? (
        <EmptyState icon={<FileCode2Icon />}>No files match the filter.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Path</TableHead>
              <TableHead>Language</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Chunks</TableHead>
              <TableHead className="text-right">Symbols</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((file) => (
              <TableRow key={file.id}>
                <TableCell>
                  {file.error ? (
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex items-center gap-1 font-mono text-xs"><CircleAlertIcon className="size-3.5 text-destructive" />{file.path}</span>} />
                      <TooltipContent className="max-w-xs">{file.error}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="font-mono text-xs">{file.path}</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{file.language ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatBytes(file.size)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{file._count.chunks}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{file._count.symbols}</TableCell>
                <TableCell>
                  <Badge variant={FILE_STATUS_VARIANT[file.status] ?? "outline"}>{file.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PanelCard>
  )
}


function SymbolsTab({ slug }: { slug: string }) {
  const [query, setQuery] = React.useState("")
  const [kind, setKind] = React.useState<string>("")
  const [symbols, setSymbols] = React.useState<SymbolDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
      try {
        const params = new URLSearchParams({ limit: "200" })
        if (query) params.set("q", query)
        if (kind) params.set("kind", kind)
        const data = await getJson<{ symbols: SymbolDto[] }>(`/api/v1/projects/${slug}/symbols?${params}`)
        setSymbols(data.symbols)
        setError(null)
      } finally {
        setLoading(false)
      }
    }, [slug, query, kind])

  const refresh = React.useCallback(() => {
    setLoading(true)
    setError(null)
    return load().catch((err: Error) => setError(err.message))
  }, [load])

  React.useEffect(() => {
    void load()
  }, [load])

  return (
    <PanelCard
      title="Symbols"
      description={`${symbols.length} symbol${symbols.length === 1 ? "" : "s"} shown`}
      action={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void refresh()
          }}
        >
          <Input
            placeholder="Filter by name…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-44!"
          />
          <Select
            value={kind || null}
            onValueChange={(value) => {
              setKind(value ?? "")
              void refresh()
            }}
          >
            <SelectTrigger className="w-32!">
              <SelectValue placeholder="Any kind" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={null}>Any kind</SelectItem>
              {SYMBOL_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </form>
      }
    >
      {error && (
        <Alert variant="destructive" className="mx-3!">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && symbols.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span className="text-sm">Loading symbols…</span>
        </div>
      ) : symbols.length === 0 ? (
        <EmptyState icon={<BracesIcon />}>No symbols match the filter.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Language</TableHead>
              <TableHead>Location</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {symbols.map((symbol) => (
              <TableRow key={symbol.id}>
                <TableCell className="font-mono text-xs">{symbol.qualifiedName}</TableCell>
                <TableCell>
                  <Badge variant="outline">{symbol.kind}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{symbol.language}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground" title={symbol.path}>
                  {symbol.path}:{symbol.startLine}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PanelCard>
  )
}


const SEARCH_MODES = [
  { value: "hybrid", label: "Hybrid" },
  { value: "lexical", label: "Lexical" },
  { value: "semantic", label: "Semantic" },
  { value: "symbol", label: "Symbol" },
]

interface SearchResultItem {
  path: string
  language: string
  symbol: string | null
  symbolKind: string | null
  startLine: number
  endLine: number
  content: string
  chunkType: string
  hybridScore: number
  provenance: string[]
}

function SearchTab({ slug }: { slug: string }) {
  const [query, setQuery] = React.useState("")
  const [mode, setMode] = React.useState("hybrid")
  const [items, setItems] = React.useState<SearchResultItem[]>([])
  const [tookMs, setTookMs] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = async (q: string) => {
    if (!q.trim()) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ q, mode })
      const data = await getJson<{ items: SearchResultItem[]; tookMs: number }>(`/api/v1/projects/${slug}/search?${params}`)
      setItems(data.items)
      setTookMs(data.tookMs)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <PanelCard title="Search" description="Search across chunks in this project.">
      <form
        className="flex flex-wrap items-center gap-2 py-1!"
        onSubmit={(event) => {
          event.preventDefault()
          void run(query)
        }}
      >
        <Input
          placeholder="Search code, docs, tests…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full max-w-96!"
        />
        <Select value={mode} onValueChange={(value) => setMode(value ?? "hybrid")}>
          <SelectTrigger className="w-28!">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEARCH_MODES.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={loading}>
          {loading ? <Loader2Icon className="size-4 animate-spin" /> : <SearchIcon />}
          Search
        </Button>
      </form>
      {error && (
        <Alert variant="destructive" className="mx-3!">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {tookMs !== null && (
        <div className="py-2! text-xs text-muted-foreground">
          {items.length} result{items.length === 1 ? "" : "s"} in {tookMs}ms
        </div>
      )}
      {items.length === 0 ? (
        !loading && <EmptyState icon={<SearchIcon />}>Run a search to see matching chunks.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2 py-2!">
          {items.map((item) => (
            <Card key={`${item.path}:${item.startLine}`} size="sm">
              <CardContent className="flex flex-col gap-1.5!">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-mono">{item.path}</span>
                  <span className="text-muted-foreground">:{item.startLine}</span>
                  {item.language && <Badge variant="outline">{item.language}</Badge>}
                  <Badge variant="secondary">{item.chunkType}</Badge>
                  {item.provenance.map((p) => (
                    <Badge key={p} variant="ghost">
                      {p}
                    </Badge>
                  ))}
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {item.hybridScore.toFixed(2)}
                  </span>
                </div>
                {item.symbol && (
                  <div className="font-mono text-xs text-muted-foreground">
                    {item.symbolKind ? `${item.symbolKind} ` : ""}
                    {item.symbol}
                  </div>
                )}
                <pre className="max-h-32 overflow-hidden text-xs leading-5 text-muted-foreground">
                  {item.content.slice(0, 600)}
                </pre>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PanelCard>
  )
}


function JobsTab({ slug }: { slug: string }) {
  const [jobs, setJobs] = React.useState<JobDto[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const data = await getJson<{ jobs: JobDto[] }>(`/api/v1/jobs?project=${slug}&limit=50`)
      setJobs(data.jobs)
    } finally {
      setLoading(false)
    }
  }, [slug])

  React.useEffect(() => {
    void load()
    const interval = setInterval(() => void load(), 5000)
    return () => clearInterval(interval)
  }, [load])

  const cancel = async (id: string) => {
    const result = await postAction(`/api/v1/jobs/${id}/cancel`)
    if (result.ok) toast.success("Job cancelled.")
    else toast.error(result.message ?? "Could not cancel job.")
    void load()
  }

  const retry = async (id: string) => {
    const result = await postAction(`/api/v1/jobs/${id}/retry`)
    if (result.ok) toast.success("Job re-queued.")
    else toast.error(result.message ?? "Could not retry job.")
    void load()
  }

  return (
    <PanelCard title="Jobs" description="Polling every 5 seconds.">
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span className="text-sm">Loading jobs…</span>
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState icon={<CircleXIcon />}>No jobs for this project.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-48">Progress</TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell className="text-muted-foreground">{jobTypeLabel(job.type)}</TableCell>
                <TableCell>
                  <Badge variant={job.status === "failed" ? "destructive" : job.status === "running" ? "default" : job.status === "queued" ? "secondary" : "outline"}>
                    {job.status}
                  </Badge>
                </TableCell>
                <TableCell className="w-48">
                  {job.error ? (
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-destructive"><CircleAlertIcon />{job.progress}%</span>} />
                      <TooltipContent className="max-w-xs">{job.error}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Progress value={job.progress} className="w-48 gap-1.5!">
                      <ProgressValue className="text-xs" />
                    </Progress>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatRelative(job.startedAt ?? job.createdAt)}</TableCell>
                <TableCell className="w-28 text-right">
                  {(job.status === "queued" || job.status === "running") && (
                    <Button size="icon-sm" variant="ghost" onClick={() => void cancel(job.id)} title="Cancel">
                      <OctagonXIcon />
                    </Button>
                  )}
                  {(job.status === "failed" || job.status === "cancelled") && (
                    <Button size="icon-sm" variant="ghost" onClick={() => void retry(job.id)} title="Retry">
                      <RotateCcwIcon />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PanelCard>
  )
}


function SettingsTab({
  slug,
  embedding,
  indexStatus,
  webhook,
}: {
  slug: string
  embedding: { provider: string | null; model: string | null; apiUrl: string | null; dimensions: number | null; batchSize: number | null }
  indexStatus: IndexStatus
  webhook: WebhookInfo
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [showSecret, setShowSecret] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const saveEmbedding = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const embeddingBody: Record<string, string | number> = {}
    const provider = (form.get("provider") as string | undefined)?.trim()
    const apiUrl = (form.get("apiUrl") as string | undefined)?.trim()
    const apiKey = (form.get("apiKey") as string | undefined)?.trim()
    const model = (form.get("model") as string | undefined)?.trim()
    const dimensions = (form.get("dimensions") as string | undefined)?.trim()
    const batchSize = (form.get("batchSize") as string | undefined)?.trim()
    if (provider) embeddingBody.provider = provider
    if (apiUrl) embeddingBody.apiUrl = apiUrl
    if (apiKey) embeddingBody.apiKey = apiKey
    if (model) embeddingBody.model = model
    if (dimensions) embeddingBody.dimensions = Number(dimensions)
    if (batchSize) embeddingBody.batchSize = Number(batchSize)

    setBusy(true)
    setError(null)
    const res = await fetch(`/api/v1/projects/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embedding: embeddingBody }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      setError((json as { error?: { message?: string } })?.error?.message ?? "Could not save settings.")
    } else {
      toast.success("Embedding settings saved.")
      router.refresh()
    }
    setBusy(false)
  }

  const onDelete = async () => {
    const result = await deleteProject(slug)
    if (!result.ok) {
      toast.error(result.message ?? "Could not delete project.")
      return
    }
    toast.success("Project deletion queued.")
    router.push("/projects")
  }

  return (
    <div className="flex flex-col gap-6">
      <PanelCard title="Embedding configuration" description="Per-project overrides; blank fields fall back to system defaults.">
        <form
          onSubmit={saveEmbedding}
          className="flex flex-col gap-3 px-3! py-3!"
        >
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="embedding-provider">Provider</Label>
              <Input id="embedding-provider" name="provider" defaultValue={embedding.provider ?? ""} placeholder="e.g. openai" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="embedding-model">Model</Label>
              <Input id="embedding-model" name="model" defaultValue={embedding.model ?? ""} placeholder="e.g. text-embedding-3-small" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="embedding-api-url">API URL</Label>
              <Input id="embedding-api-url" name="apiUrl" defaultValue={embedding.apiUrl ?? ""} type="url" placeholder="https://…/v1" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="embedding-api-key">API key</Label>
              <Input id="embedding-api-key" name="apiKey" type="password" autoComplete="off" placeholder="•••••••• (overrides stored key)" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="embedding-dimensions">Dimensions</Label>
              <Input id="embedding-dimensions" name="dimensions" type="number" min={1} max={8192} defaultValue={embedding.dimensions ?? ""} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="embedding-batch-size">Batch size</Label>
              <Input id="embedding-batch-size" name="batchSize" type="number" min={1} max={512} defaultValue={embedding.batchSize ?? ""} />
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Current model: <span className="font-mono">{indexStatus.embeddingModel ?? "system default"}</span>
            {indexStatus.embeddingDimensions ? ` · ${indexStatus.embeddingDimensions}d` : ""}
            {indexStatus.embeddingVersion ? ` · version ${indexStatus.embeddingVersion}` : ""}
          </div>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            Save settings
          </Button>
        </form>
      </PanelCard>

      <PanelCard title="Webhook" description="GitHub push events keep this repository in sync.">
        <div className="flex flex-col gap-3 px-3! py-3!">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webhook-url">Endpoint URL</Label>
            <div className="flex items-center gap-2">
              <Input id="webhook-url" readOnly value={webhook.url} className="font-mono! text-xs!" />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void navigator.clipboard.writeText(webhook.url).then(() => toast.success("URL copied."))}
                title="Copy URL"
              >
                <CopyIcon />
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webhook-secret">Secret</Label>
            <div className="flex items-center gap-2">
              <Input
                id="webhook-secret"
                readOnly
                type={showSecret ? "text" : "password"}
                value={webhook.secret}
                className="font-mono! text-xs!"
              />
              <Button size="icon-sm" variant="ghost" onClick={() => setShowSecret(!showSecret)} title={showSecret ? "Hide secret" : "Reveal secret"}>
                {showSecret ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void navigator.clipboard.writeText(webhook.secret).then(() => toast.success("Secret copied."))}
                title="Copy secret"
              >
                <CopyIcon />
              </Button>
            </div>
          </div>
        </div>
      </PanelCard>

      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>Deleting a project removes its index, vectors, and workspace asynchronously.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3!">
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          <Dialog>
            <DialogTrigger render={<Button variant="destructive" />}>
              <Trash2Icon />
              Delete project
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete this project?</DialogTitle>
                <DialogDescription>
                  The repository index, vectors, and workspace for this project will be removed. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter showCloseButton>
                <Button variant="destructive" onClick={() => void onDelete()}>
                  Delete project
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  )
}


export function ProjectTabs({
  slug,
  stats,
  indexStatus,
  recentJobs,
  webhook,
}: {
  slug: string
  stats: ProjectStats
  indexStatus: IndexStatus
  recentJobs: JobDto[]
  webhook: WebhookInfo
}) {
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="symbols">Symbols</TabsTrigger>
        <TabsTrigger value="search">Search</TabsTrigger>
        <TabsTrigger value="jobs">Jobs</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <OverviewTab stats={stats} indexStatus={indexStatus} recentJobs={recentJobs} />
      </TabsContent>
      <TabsContent value="files">
        <FilesTab slug={slug} />
      </TabsContent>
      <TabsContent value="symbols">
        <SymbolsTab slug={slug} />
      </TabsContent>
      <TabsContent value="search">
        <SearchTab slug={slug} />
      </TabsContent>
      <TabsContent value="jobs">
        <JobsTab slug={slug} />
      </TabsContent>
      <TabsContent value="settings">
        <SettingsTab
          slug={slug}
          embedding={{ provider: null, model: null, apiUrl: null, dimensions: null, batchSize: null }}
          indexStatus={indexStatus}
          webhook={webhook}
        />
      </TabsContent>
    </Tabs>
  )
}