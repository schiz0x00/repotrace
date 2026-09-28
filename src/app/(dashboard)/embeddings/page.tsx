import Link from "next/link"
import { api } from "@/components/dashboard/data"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { CircleCheckIcon, OctagonXIcon, BoxesIcon, Loader2Icon } from "lucide-react"
import type { HealthResponse, IndexStatus, ProjectDto } from "@/components/dashboard/types"
import { formatNumber } from "@/components/dashboard/types"

interface ProjectsResponse {
  projects: ProjectDto[]
}

interface IndexStatusResponse {
  indexStatus: IndexStatus
}

export default async function EmbeddingsPage() {
  // The embedding probe lives on the authenticated status endpoint; the public
  // /api/v1/health liveness probe does not report embedding health at all.
  const health = await api<HealthResponse>("/api/v1/health/status")
  const { projects } = await api<ProjectsResponse>("/api/v1/projects")
  // A per-project status read that fails must stay distinguishable from one
  // that succeeded and reported nothing. Returning `indexStatus: null` alone
  // made the row fall back to the project record and render as the system
  // default, and made the project invisible to the re-embed check — so an
  // unreadable status read looked exactly like a healthy index. The error is
  // carried alongside and surfaced in the row and in an alert.
  const statuses = await Promise.all(
    projects.map(async (project) => {
      try {
        const { indexStatus } = await api<IndexStatusResponse>(`/api/v1/projects/${project.slug}/index-status`)
        return { project, indexStatus, indexStatusError: null as string | null }
      } catch (err) {
        return { project, indexStatus: null, indexStatusError: (err as Error).message }
      }
    }),
  )
  const unreadable = statuses.filter((s) => s.indexStatusError !== null)
  const embedding = health.checks.embedding

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Embeddings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Embedding provider health and per-project vector stores.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Embedding API</CardTitle>
          <CardDescription>System-wide embedding provider (per-project overrides shown below).</CardDescription>
        </CardHeader>
        <CardContent>
          {!embedding.configured ? (
            <Alert>
              <Loader2Icon className="size-4" />
              <AlertTitle>Not configured</AlertTitle>
              <AlertDescription>
                Set <span className="font-mono">EMBEDDING_API_URL</span> and{" "}
                <span className="font-mono">EMBEDDING_MODEL</span> to enable semantic search.
              </AlertDescription>
            </Alert>
          ) : embedding.healthy ? (
            <Alert>
              <CircleCheckIcon />
              <AlertTitle>Reachable</AlertTitle>
              <AlertDescription>
                The embedding endpoint responded successfully
                {embedding.httpStatus ? ` (HTTP ${embedding.httpStatus})` : ""}.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <OctagonXIcon />
              <AlertTitle>Unreachable</AlertTitle>
              <AlertDescription>
                {embedding.error ?? "The embedding endpoint did not respond."}
                {embedding.httpStatus ? ` (HTTP ${embedding.httpStatus})` : ""}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vector stores</CardTitle>
          <CardDescription>Vectors per project stored in Qdrant.</CardDescription>
        </CardHeader>
        <CardContent className="p-0!">
          {unreadable.length > 0 && (
            <div className="px-6 pt-6">
              {/* These projects are excluded from the check below: `reembedRequired`
                  comes from the same read that failed, so they are neither known
                  to need a re-embed nor known to be fine. Saying so beats a
                  clean-looking table. */}
              <Alert variant="destructive">
                <OctagonXIcon />
                <AlertTitle>Index status unreadable</AlertTitle>
                <AlertDescription>
                  The index status of {unreadable.map((s) => s.project.name).join(", ")} could not be read, so
                  {" "}
                  {unreadable.length === 1 ? "its" : "their"} re-embed state is unknown and{" "}
                  {unreadable.length === 1 ? "it is" : "they are"} not covered by the check below:{" "}
                  {unreadable.map((s) => s.indexStatusError).join("; ")}
                </AlertDescription>
              </Alert>
            </div>
          )}
          {statuses.some((s) => s.indexStatus?.reembedRequired) && (
            <div className="px-6 pt-6">
              <Alert variant="destructive">
                <OctagonXIcon />
                <AlertTitle>Re-embed required</AlertTitle>
                <AlertDescription>
                  {statuses
                    .filter((s) => s.indexStatus?.reembedRequired)
                    .map((s) => s.project.name)
                    .join(", ")}{" "}
                  changed embedding model or dimensions. Existing vectors were produced by a different model and
                  cannot be compared against new ones — trigger a reembed to rebuild the index.
                </AlertDescription>
              </Alert>
            </div>
          )}
          {statuses.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <BoxesIcon className="size-6" />
              <p className="text-sm">No projects indexed yet.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Dimensions</TableHead>
                  <TableHead className="text-right">Vectors</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statuses.map(({ project, indexStatus, indexStatusError }) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <Link href={`/projects/${project.slug}`} className="font-medium hover:underline">
                        {project.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {/* The project record is a configured value, not the one the
                          index was actually built with, so it is only shown when the
                          status read succeeded and gave us nothing better. On a failed
                          read the cell says the status is unknown rather than naming a
                          model nobody has confirmed. */}
                      {indexStatusError
                        ? "unknown"
                        : (indexStatus?.embeddingModel ?? project.embedding.model ?? "system default")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {indexStatus?.embeddingDimensions ?? project.embedding.dimensions ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {indexStatus ? (indexStatus.vectors >= 0 ? formatNumber(indexStatus.vectors) : "—") : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={project.status === "error" ? "destructive" : project.status === "syncing" ? "default" : "outline"}>
                          {project.status}
                        </Badge>
                        {indexStatusError && (
                          <Badge variant="destructive" title={indexStatusError}>
                            index status unknown
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}