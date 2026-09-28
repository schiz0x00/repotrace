"use client"

import * as React from "react"
import Link from "next/link"
import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { SearchIcon, Loader2Icon, CodeXmlIcon, CircleAlertIcon } from "lucide-react"
import { getJson, pickDefaultProject } from "@/components/dashboard/dashboard-helpers"

const MODES = [
  { value: "hybrid", label: "Hybrid" },
  { value: "lexical", label: "Lexical" },
  { value: "semantic", label: "Semantic" },
  { value: "symbol", label: "Symbol" },
]

interface ProjectBrief {
  slug: string
  name: string
}

interface ResultItem {
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

interface SearchData {
  items: ResultItem[]
  tookMs: number
  sources: { vector: number; lexical: number; symbol: number }
  project: { name: string } | null
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchBody />
    </Suspense>
  )
}

function SearchBody() {
  const searchParams = useSearchParams()
  // `null` means "not loaded yet" — distinct from an empty list, so the page
  // does not flash "No projects yet" while the request is still in flight.
  const [projects, setProjects] = React.useState<ProjectBrief[] | null>(null)
  const paramProject = searchParams.get("project") ?? ""
  const [project, setProject] = React.useState(paramProject)
  // `useSearchParams` re-renders this component when a client-side navigation
  // changes the query string — the command palette links to /search?project=SLUG
  // — but a useState initializer runs only on mount, so navigating to another
  // project from an already-mounted page kept the previous selection. Re-syncing
  // during render keeps the URL authoritative; React discards the render that
  // assigns state, so the stale value is never painted. Guarding the assignment
  // in an `if` is what keeps it legal here: this repo's setState-in-render and
  // setState-in-effect rules both error on an unconditional call, so the
  // alternative — setting it from an effect — is not available.
  //
  // Only a PRESENT parameter is applied. An absent one is silence, not a
  // request to deselect: the sidebar links to a bare `/search`, and treating
  // that as "project = none" wiped a working selection every time the operator
  // used it. The default is applied once, by the fetch below.
  const [syncedParam, setSyncedParam] = React.useState(paramProject)
  if (paramProject && paramProject !== syncedParam) {
    setSyncedParam(paramProject)
    setProject(paramProject)
  }
  const [query, setQuery] = React.useState("")
  const [mode, setMode] = React.useState("hybrid")
  const [result, setResult] = React.useState<SearchData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [projectsError, setProjectsError] = React.useState<string | null>(null)

  React.useEffect(() => {
    // Empty dependency list on purpose: this effect writes `project` itself, so
    // depending on it would refetch /api/v1/projects every time the default was
    // applied — two requests per page load. The functional update reads the
    // current value instead, so a `?project=` parameter or a later choice wins.
    void getJson<{ projects: ProjectBrief[] }>("/api/v1/projects")
      .then(({ projects: list }) => {
        setProjects(list)
        setProjectsError(null)
        setProject((current) => pickDefaultProject(current, list))
      })
      .catch((err: Error) => {
        // Swallowed, this left the page rendering "No projects yet" — which
        // reads as "you have not created a project" when the truth is that the
        // request failed, e.g. an expired session.
        setProjectsError(err.message)
      })
  }, [])

  const run = async () => {
    if (!project) {
      setError("Select a project first.")
      return
    }
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ project, q: query, mode })
      const data = await getJson<SearchData>(`/api/v1/search?${params}`)
      setResult(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">Search across indexed code, tests, docs, and configuration.</p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project">Project</Label>
          <Select value={project || null} onValueChange={(value) => setProject(value ?? "")}>
            <SelectTrigger className="w-48!">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.slug} value={p.slug}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mode">Mode</Label>
          <Select value={mode} onValueChange={(value) => setMode(value ?? "hybrid")}>
            <SelectTrigger className="w-32!">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="q">Query</Label>
          <div className="flex items-center gap-2">
            <Input
              id="q"
              autoFocus
              placeholder="What are you looking for?"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-72!"
            />
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2Icon className="size-4 animate-spin" /> : <SearchIcon />}
              Search
            </Button>
          </div>
        </div>
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <div className="flex flex-col gap-1! text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {result.items.length} result{result.items.length === 1 ? "" : "s"} in {result.tookMs}ms
              {result.project ? ` in ${result.project.name}` : ""}
            </span>
            <Badge variant="ghost">{result.sources.vector} vector</Badge>
            <Badge variant="ghost">{result.sources.lexical} lexical</Badge>
            <Badge variant="ghost">{result.sources.symbol} symbol</Badge>
          </div>
          {result.items.length === 0 && (
            <Alert>
              <AlertDescription>No matches. Try a different query or mode.</AlertDescription>
            </Alert>
          )}
          {result.items.map((item) => (
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
                  <span className="ml-auto tabular-nums text-muted-foreground">{item.hybridScore.toFixed(2)}</span>
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

      {!result && !error && projectsError && (
        <Alert variant="destructive">
          <CircleAlertIcon className="size-4" />
          <AlertTitle>Could not load projects</AlertTitle>
          <AlertDescription>{projectsError}</AlertDescription>
        </Alert>
      )}
      {!result && !error && !projectsError && projects === null && (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span className="text-sm">Loading projects…</span>
        </div>
      )}
      {!result && !error && !projectsError && projects !== null && projects.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
            <CodeXmlIcon className="size-6" />
            <p className="text-sm">
              No projects yet.{" "}
              <Link href="/projects" className="text-foreground hover:underline">
                Create one
              </Link>{" "}
              to start searching.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}