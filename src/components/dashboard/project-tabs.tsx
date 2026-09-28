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
import { apiErrorMessage, createRequestGate, deleteProject, getJson, postAction } from "@/components/dashboard/dashboard-helpers"
import {
  FileCode2Icon,
  BracesIcon,
  BoxesIcon,
  GitCommitHorizontalIcon,
  TargetIcon,
  CircleXIcon,
  CircleCheckIcon,
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
import type {
  CommitsResponse,
  EvalsResponse,
  FileDto,
  IndexStatus,
  JobDto,
  ProjectStats,
  SymbolDto,
  WebhookInfo,
} from "@/components/dashboard/types"
import { formatBytes, formatNumber, formatRelative } from "@/components/dashboard/types"

/**
 * Clipboard write with the rejection handled: `navigator.clipboard.writeText`
 * rejects when the document is not focused or permission is denied, and an
 * unhandled rejection in a click handler is silent.
 */
async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied.`)
  } catch {
    toast.error("Could not copy — your browser blocked clipboard access.")
  }
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

/**
 * Body that removes every per-project embedding override.
 *
 * `null` is the API's "remove this field"; an absent key means "leave it
 * alone". The key is included even though this form can never display it,
 * because a stored key is otherwise unreachable: blanking the field is
 * indistinguishable, on the wire, from leaving it unchanged.
 */
export const CLEARED_EMBEDDING_OVERRIDES = {
  provider: null,
  apiUrl: null,
  apiKey: null,
  model: null,
  dimensions: null,
  batchSize: null,
} as const


function IndexStatusAlert({ indexStatus, indexStatusError }: { indexStatus: IndexStatus | null; indexStatusError: string | null }) {
  // `reembedRequired` comes out of the same read that failed, so a project whose
  // status could not be read is neither known to need a re-embed nor known to be
  // fine. Falling through to the healthy branch — or to the project record's
  // configured model — presented an unreadable index as a healthy one.
  if (indexStatus === null) {
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Index status unreadable</AlertTitle>
        <AlertDescription>
          The index status of this project could not be read, so its vector count and re-embed state are unknown — it is
          neither known to need a re-embed nor known to be healthy. {indexStatusError ?? "The request failed."}
        </AlertDescription>
      </Alert>
    )
  }
  if (indexStatus.reembedRequired) {
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Re-embed required</AlertTitle>
        <AlertDescription>
          The embedding model or dimensions changed after these vectors were written. They were produced by a different
          model and cannot be compared against new ones — trigger a re-embed to rebuild the index.
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

function OverviewTab({
  stats,
  indexStatus,
  indexStatusError,
  recentJobs,
}: {
  stats: ProjectStats
  indexStatus: IndexStatus | null
  indexStatusError: string | null
  recentJobs: JobDto[]
}) {
  const cards = [
    { icon: <FileCode2Icon />, label: "Files", value: formatNumber(stats.files) },
    { icon: <BracesIcon />, label: "Symbols", value: formatNumber(stats.symbols) },
    { icon: <BoxesIcon />, label: "Chunks", value: formatNumber(stats.chunks) },
    {
      icon: <BoxesIcon />,
      label: "Vectors",
      // "n/a" means the server reported a negative count; "unknown" means the
      // server never answered. Collapsing the two is the bug this avoids.
      value: indexStatus === null ? "unknown" : indexStatus.vectors >= 0 ? formatNumber(indexStatus.vectors) : "n/a",
    },
    { icon: <GitCommitHorizontalIcon />, label: "Commits", value: formatNumber(stats.commits) },
  ]
  return (
    <div className="flex flex-col gap-4">
      <IndexStatusAlert indexStatus={indexStatus} indexStatusError={indexStatusError} />
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

// Monotonic request counter; see the note inside `load` for what it is for.
const [gate] = React.useState(createRequestGate)

// Why a separate callback rather than inlining the fetch in the effect: the
// effect below is keyed on `load`, so `load`'s dependency list ([slug, query])
// is what decides when a filter change re-fetches. Inlining would spread that
// list across the effect's deps and make `refresh` a second copy of the request.
// It is not about render timing — every setState here is in a promise callback,
// after the effect that started the request has already returned.
const load = React.useCallback(
    (page = 1) => {
      // `query` is live on every keystroke and each keystroke fires a request,
      // so responses can arrive out of order: a slow request for "src/" would
      // otherwise land after a fast one for "src/app" and repopulate the table
      // with results for a prefix the user has typed past. The gate counts
      // requests; a response is applied only if it is still the newest.
      const requestId = gate.next()
      const params = new URLSearchParams({ page: String(page), pageSize: "100" })
      if (query) params.set("path", query)
      return getJson<{ files: FileDto[]; total: number }>(`/api/v1/projects/${slug}/files?${params}`)
        .then((data) => {
          if (!gate.isCurrent(requestId)) return
          setFiles(data.files)
          setTotal(data.total)
          setError(null)
        })
        // The catch used to live in `refresh` only, so the first load — the one
        // the effect below fires — rejected unhandled and rendered the empty
        // state, reading as "no files match" when the request had failed.
        .catch((err: Error) => {
          if (!gate.isCurrent(requestId)) return
          setError(err.message)
        })
        .finally(() => {
          if (!gate.isCurrent(requestId)) return
          setLoading(false)
        })
    },
    [slug, query, gate],
  )

  const refresh = React.useCallback(
    (page = 1) => {
      setLoading(true)
      setError(null)
      return load(page)
    },
    [load],
  )

  // No cleanup needed: when `slug` or `query` changes, this effect re-runs,
  // which bumps the counter and retires the in-flight request. On unmount React
  // ignores a setState aimed at a component that is gone.
  React.useEffect(() => {
    void load()
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
      ) : files.length === 0 && error ? (
        // "We could not ask" is not "there is nothing here": showing the empty
        // state next to a failed request sent people hunting for a filter
        // problem that did not exist.
        <p className="px-6 py-6 text-sm text-muted-foreground">Could not load files.</p>
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

  // Same out-of-order hazard as FilesTab, and the same fix: the name filter is
  // live per keystroke, so responses can arrive in the reverse order they were
  // requested and the newest one has to win.
  const [gate] = React.useState(createRequestGate)

  const load = React.useCallback(() => {
      const requestId = gate.next()
      const params = new URLSearchParams({ limit: "200" })
      if (query) params.set("q", query)
      if (kind) params.set("kind", kind)
      return getJson<{ symbols: SymbolDto[] }>(`/api/v1/projects/${slug}/symbols?${params}`)
        .then((data) => {
          if (!gate.isCurrent(requestId)) return
          setSymbols(data.symbols)
          setError(null)
        })
        // Same defect as FilesTab: the first load ran through this callback with
        // no catch, so a failure produced an unhandled rejection and an empty
        // state that looked like a genuinely symbol-free project.
        .catch((err: Error) => {
          if (!gate.isCurrent(requestId)) return
          setError(err.message)
        })
        .finally(() => {
          if (!gate.isCurrent(requestId)) return
          setLoading(false)
        })
    }, [slug, query, kind, gate])

  const refresh = React.useCallback(() => {
    setLoading(true)
    setError(null)
    return load()
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
              // `setKind` alone is enough: `load` closes over `kind`, so the
              // new value gives `load` a new identity and the effect that
              // loads symbols refires with it. Calling `refresh()` here as
              // well issued a second request carrying the *previous* kind,
              // because that render's `refresh` had not seen the update yet.
              setKind(value ?? "")
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
      ) : symbols.length === 0 && error ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">Could not load symbols.</p>
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
  const [error, setError] = React.useState<string | null>(null)

  // The catch here used to be missing, so the 5s interval produced an unhandled
  // rejection on every tick, and the render below fell through to "No jobs for
  // this project" — a failed request presented as a project with no history.
  const load = React.useCallback(
    () =>
      getJson<{ jobs: JobDto[] }>(`/api/v1/jobs?project=${slug}&limit=50`)
        .then((data) => {
          setJobs(data.jobs)
          setError(null)
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false)),
    [slug],
  )

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
      {/* The message is rendered above the branches below on purpose: gating it
          on `jobs.length === 0` meant a poll that failed after the table had
          loaded left the stale rows on screen with nothing saying live updates
          had stopped. */}
      {error && (
        <Alert variant="destructive" className="mx-3!">
          <TriangleAlertIcon />
          <AlertTitle>Live updates are failing</AlertTitle>
          <AlertDescription>
            {error} Polling retries every 5 seconds; anything below is the last data that loaded.
          </AlertDescription>
        </Alert>
      )}
      {loading && jobs.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span className="text-sm">Loading jobs…</span>
        </div>
      ) : jobs.length === 0 && error ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">
          This usually means the session expired. Reload to sign in again.
        </p>
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


/**
 * Which secret actually verifies this project's deliveries.
 *
 * `webhookSecretFor()` on the server prefers the process-wide
 * GITHUB_WEBHOOK_SECRET over the per-project secret, but the settings endpoint
 * always returns the per-project one. An operator told to configure "this
 * secret" in GitHub therefore wrote a secret that every delivery would then be
 * rejected against — and the rejections look like a broken GitHub hook. The
 * dashboard says which of the two is in force instead of showing a value that
 * may be irrelevant.
 */
export type WebhookSecretSource = "project" | "global"

function SettingsTab({
  slug,
  embedding,
  indexStatus,
  indexStatusError,
  webhook,
  webhookSecretSource,
}: {
  slug: string
  embedding: { provider: string | null; model: string | null; apiUrl: string | null; dimensions: number | null; batchSize: number | null }
  indexStatus: IndexStatus | null
  indexStatusError: string | null
  webhook: WebhookInfo
  webhookSecretSource: WebhookSecretSource
}) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [showSecret, setShowSecret] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [clearOpen, setClearOpen] = React.useState(false)
  // The fields are uncontrolled (`defaultValue`), so a refresh that changes the
  // server's copy of a value does not necessarily change what is on screen:
  // once the operator has typed in an input, the browser keeps the typed value
  // and ignores the new default. After a successful write the form is remounted
  // so it shows what the server actually stored — otherwise "overrides
  // removed" leaves the old model sitting in the box, which is the one thing
  // the operator would not believe.
  const [formVersion, setFormVersion] = React.useState(0)

  const patchEmbedding = async (body: Record<string, unknown>, successMessage: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    // try/finally: a transport failure rejects the fetch, and without this the
    // Save button stayed disabled and spinning with nothing on screen.
    try {
      const res = await fetch(`/api/v1/projects/${slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embedding: body }),
      })
      if (!res.ok) {
        // The 400 carries the offending field in `details`; without it the
        // operator is told only that "validation failed" and retries the same
        // payload.
        setError(apiErrorMessage(await res.json().catch(() => null), res.status, "Could not save settings."))
        return false
      }
      setFormVersion((version) => version + 1)
      toast.success(successMessage)
      router.refresh()
      return true
    } catch (err) {
      setError(`Could not save settings: ${(err as Error).message}`)
      return false
    } finally {
      setBusy(false)
    }
  }

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
    // A blank field is "leave this override alone", never "remove it": the two
    // are different requests to the API and conflating them is what made the
    // override impossible to remove — the key was simply never sent, so the
    // saved value came back unchanged and the save read as if it had worked.
    if (provider) embeddingBody.provider = provider
    if (apiUrl) embeddingBody.apiUrl = apiUrl
    if (apiKey) embeddingBody.apiKey = apiKey
    if (model) embeddingBody.model = model
    if (dimensions) embeddingBody.dimensions = Number(dimensions)
    if (batchSize) embeddingBody.batchSize = Number(batchSize)

    if (Object.keys(embeddingBody).length === 0) {
      // Sending an empty object here answered 200 and changed nothing, so the
      // operator was told the settings were saved.
      setError(
        "Nothing to save: every field is blank. A blank field leaves the current override unchanged — to fall back to the system defaults, use “Remove all overrides”.",
      )
      return
    }

    // Fields that had an override and were left blank are the trap this form is
    // built around: the save succeeds, the override survives, and nothing on
    // screen says so. Name them.
    const kept: string[] = []
    if (embedding.provider && !provider) kept.push("provider")
    if (embedding.apiUrl && !apiUrl) kept.push("API URL")
    if (embedding.model && !model) kept.push("model")
    if (embedding.dimensions !== null && !dimensions) kept.push("dimensions")
    if (embedding.batchSize !== null && !batchSize) kept.push("batch size")

    if (!(await patchEmbedding(embeddingBody, "Embedding settings saved."))) return
    setNotice(
      kept.length > 0
        ? `Left blank, so the stored override was kept: ${kept.join(", ")}. A blank field never removes a value — use “Remove all overrides” for that.`
        : null,
    )
  }

  /**
   * Removal is an explicit request: every override key is sent as `null`,
   * which the API distinguishes from "absent" (leave unchanged) and from a
   * value (set). The stored API key goes too — it is the one field this form
   * can never show back, so it has no other way to be replaced.
   */
  const clearEmbedding = async () => {
    if (await patchEmbedding(CLEARED_EMBEDDING_OVERRIDES, "All per-project embedding overrides removed. This project now uses the system defaults.")) {
      setNotice(null)
      // Close on success only: a failure leaves the dialog open with the error
      // visible next to the button that caused it, instead of dismissing the
      // thing the operator needs to read.
      setClearOpen(false)
    }
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
      <PanelCard
        title="Embedding configuration"
        description="Per-project overrides of the system defaults. A blank field leaves the stored override unchanged; “Remove all overrides” clears them and falls back to the system defaults."
      >
        <form
          key={formVersion}
          onSubmit={saveEmbedding}
          className="flex flex-col gap-3 px-3! py-3!"
        >
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert>
              <CircleCheckIcon />
              <AlertDescription>{notice}</AlertDescription>
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
            {/* The configured override and the model the index was actually built
                with are different things. On an unreadable index status the
                latter is unknown, and naming the configured value here (or
                "system default") would state as fact something nobody confirmed. */}
            {indexStatus === null ? (
              <>Index status unreadable — the model this index was built with is unknown{indexStatusError ? `: ${indexStatusError}` : "."}</>
            ) : (
              <>
                Current model: <span className="font-mono">{indexStatus.embeddingModel ?? "system default"}</span>
                {indexStatus.embeddingDimensions ? ` · ${indexStatus.embeddingDimensions}d` : ""}
                {indexStatus.embeddingVersion ? ` · version ${indexStatus.embeddingVersion}` : ""}
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy}>
              {busy && <Loader2Icon className="size-4 animate-spin" />}
              Save settings
            </Button>
            <Dialog open={clearOpen} onOpenChange={setClearOpen}>
              <DialogTrigger render={<Button variant="outline" />}>
                <Trash2Icon />
                Remove all overrides
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Remove every embedding override?</DialogTitle>
                  <DialogDescription>
                    This project falls back to the system-wide embedding defaults
                    {embedding.model || embedding.dimensions ? (
                      <>
                        {" "}— its configured model
                        {embedding.model ? ` (${embedding.model})` : ""}
                        {embedding.dimensions ? ` at ${embedding.dimensions}d` : ""} will no longer apply
                      </>
                    ) : null}
                    . The stored API key is removed too. If the effective model or dimensionality ends up different
                    from the one this index was built with, every existing vector becomes unusable until a re-embed job
                    refills the collection.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter showCloseButton>
                  <Button variant="destructive" disabled={busy} onClick={() => void clearEmbedding()}>
                    {busy && <Loader2Icon className="size-4 animate-spin" />}
                    Remove overrides
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </form>
      </PanelCard>

      <PanelCard title="Webhook" description="GitHub push events keep this repository in sync.">
        <div className="flex flex-col gap-3 px-3! py-3!">
          {webhookSecretSource === "global" && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>The secret below is not verifying deliveries</AlertTitle>
              <AlertDescription>
                GITHUB_WEBHOOK_SECRET is set on the server and takes precedence, so every push is verified against that
                process-wide secret. Configuring this repository with the per-project secret shown here will make every
                delivery fail with a signature mismatch. Either configure the webhook with the GITHUB_WEBHOOK_SECRET
                value, or unset it to verify per project. The global value is deliberately not displayed here — it
                authorises delivery for every project on this instance.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webhook-url">Endpoint URL</Label>
            <div className="flex items-center gap-2">
              <Input id="webhook-url" readOnly value={webhook.url} className="font-mono! text-xs!" />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void copyToClipboard(webhook.url, "URL")}
                title="Copy URL"
              >
                <CopyIcon />
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="webhook-secret">
              Secret
              {webhookSecretSource === "global" ? " (not in force)" : ""}
            </Label>
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
                onClick={() => void copyToClipboard(webhook.secret, "Secret")}
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


function CommitsTab({ slug }: { slug: string }) {
  const [data, setData] = React.useState<CommitsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const url = `/api/v1/projects/${slug}/commits?limit=50`

  // The initial fetch is inlined in the effect with every setState inside a
  // promise callback, and the `active` guard drops results that arrive after
  // the slug changes or the tab unmounts. `load` is the manual-refresh path.
  const load = React.useCallback(
    () =>
      getJson<CommitsResponse>(url)
        .then((d) => {
          setData(d)
          setError(null)
        })
        .finally(() => setLoading(false)),
    [url],
  )

  React.useEffect(() => {
    let active = true
    getJson<CommitsResponse>(url)
      .then((d) => {
        if (!active) return
        setData(d)
        setError(null)
      })
      .catch((err: Error) => {
        if (active) setError(err.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [url])

  const commits = data?.commits ?? []

  return (
    <PanelCard
      title="Commits"
      description={
        data?.repository?.lastKnownCommit
          ? `branch ${data.repository.branch} · head ${data.repository.lastKnownCommit.slice(0, 8)}`
          : "History recorded during indexing"
      }
      action={
        <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load().catch((err: Error) => setError(err.message)) }} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      }
    >
      {error ? (
        <p className="px-6 py-6 text-sm text-destructive">{error}</p>
      ) : loading ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">Loading commits…</p>
      ) : commits.length === 0 ? (
        <EmptyState icon={<GitCommitHorizontalIcon className="size-6" />}>
          No commits recorded yet. They are captured on the next sync.
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Commit</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="w-40">Author</TableHead>
              <TableHead className="w-36 text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {commits.map((c) => (
              <TableRow key={c.sha}>
                <TableCell className="font-mono text-xs text-muted-foreground">{c.shortSha}</TableCell>
                <TableCell className="max-w-0 truncate" title={c.subject}>
                  {c.subject}
                </TableCell>
                <TableCell className="truncate text-sm text-muted-foreground">{c.author}</TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {formatRelative(c.authoredAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PanelCard>
  )
}

function RetrievalTab({ slug }: { slug: string }) {
  const [data, setData] = React.useState<EvalsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const url = `/api/v1/projects/${slug}/evals`

  const load = React.useCallback(
    () =>
      getJson<EvalsResponse>(url)
        .then((d) => {
          setData(d)
          setError(null)
        })
        .finally(() => setLoading(false)),
    [url],
  )

  React.useEffect(() => {
    let active = true
    getJson<EvalsResponse>(url)
      .then((d) => {
        if (!active) return
        setData(d)
        setError(null)
      })
      .catch((err: Error) => {
        if (active) setError(err.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [url])

  const agg = data?.aggregate
  const questions = data?.questions ?? []

  return (
    <div className="flex flex-col gap-4">
      <PanelCard
        title="Retrieval quality"
        description="Recall of this project's index over its own eval questions, scored live with the same metric as `npm run eval`."
        action={
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load().catch((err: Error) => setError(err.message)) }} disabled={loading}>
            {loading ? "Scoring…" : "Re-score"}
          </Button>
        }
      >
        {error ? (
          <p className="px-6 py-6 text-sm text-destructive">{error}</p>
        ) : loading ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">Running the project&apos;s questions…</p>
        ) : questions.length === 0 ? (
          <EmptyState icon={<TargetIcon className="size-6" />}>
            No eval questions yet. Add one with POST /api/v1/projects/{slug}/evals to start tracking whether this
            index actually finds the right code.
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap gap-6 border-b px-6 py-4">
              <div>
                <p className="text-xs text-muted-foreground">recall@5</p>
                <p className="text-2xl font-semibold tabular-nums">{formatScore(agg?.recallFilesAt5)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">recall@10</p>
                <p className="text-2xl font-semibold tabular-nums">{formatScore(agg?.recallFilesAt10)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">questions</p>
                <p className="text-2xl font-semibold tabular-nums">{agg?.questions ?? 0}</p>
              </div>
              {agg && agg.failed > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">failed</p>
                  <p className="text-2xl font-semibold tabular-nums text-destructive">{agg.failed}</p>
                </div>
              )}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Question</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead className="w-24 text-right">@5</TableHead>
                  <TableHead className="w-24 text-right">@10</TableHead>
                  <TableHead>Top result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {questions.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="max-w-0 truncate" title={q.query}>
                      {q.query}
                    </TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-xs text-muted-foreground">
                      {q.expectedFiles.join(", ")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatScore(q.recallFiles[5])}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatScore(q.recallFiles[10])}</TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-xs text-muted-foreground">
                      {q.error ? <span className="text-destructive">{q.error}</span> : (q.topFiles[0] ?? "—")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data?.truncated ? (
              <p className="border-t px-6 py-3 text-xs text-muted-foreground">
                {data.truncated} question(s) were not scored; only the first 50 are run per request.
              </p>
            ) : null}
          </>
        )}
      </PanelCard>
    </div>
  )
}

function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2)
}

export function ProjectTabs({
  slug,
  stats,
  indexStatus,
  indexStatusError,
  recentJobs,
  webhook,
  webhookSecretSource,
  embedding,
}: {
  slug: string
  stats: ProjectStats
  /** null when the index-status read failed; see `indexStatusError`. */
  indexStatus: IndexStatus | null
  indexStatusError: string | null
  recentJobs: JobDto[]
  webhook: WebhookInfo
  webhookSecretSource: WebhookSecretSource
  embedding: { provider: string | null; model: string | null; apiUrl: string | null; dimensions: number | null; batchSize: number | null }
}) {
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="symbols">Symbols</TabsTrigger>
        <TabsTrigger value="search">Search</TabsTrigger>
        <TabsTrigger value="jobs">Jobs</TabsTrigger>
        <TabsTrigger value="commits">Commits</TabsTrigger>
        <TabsTrigger value="retrieval">Retrieval</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <OverviewTab
          stats={stats}
          indexStatus={indexStatus}
          indexStatusError={indexStatusError}
          recentJobs={recentJobs}
        />
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
      <TabsContent value="commits">
        <CommitsTab slug={slug} />
      </TabsContent>
      <TabsContent value="retrieval">
        <RetrievalTab slug={slug} />
      </TabsContent>
      <TabsContent value="settings">
        <SettingsTab
          slug={slug}
          embedding={embedding}
          indexStatus={indexStatus}
          indexStatusError={indexStatusError}
          webhook={webhook}
          webhookSecretSource={webhookSecretSource}
        />
      </TabsContent>
    </Tabs>
  )
}