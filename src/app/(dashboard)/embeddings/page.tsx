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
  const health = await api<HealthResponse>("/api/v1/health")
  const { projects } = await api<ProjectsResponse>("/api/v1/projects")
  const statuses = await Promise.all(
    projects.map(async (project) => {
      try {
        const { indexStatus } = await api<IndexStatusResponse>(`/api/v1/projects/${project.slug}/index-status`)
        return { project, indexStatus }
      } catch {
        return { project, indexStatus: null }
      }
    }),
  )
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
                {statuses.map(({ project, indexStatus }) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <Link href={`/projects/${project.slug}`} className="font-medium hover:underline">
                        {project.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {indexStatus?.embeddingModel ?? project.embedding.model ?? "system default"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {indexStatus?.embeddingDimensions ?? project.embedding.dimensions ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {indexStatus ? (indexStatus.vectors >= 0 ? formatNumber(indexStatus.vectors) : "—") : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={project.status === "error" ? "destructive" : project.status === "syncing" ? "default" : "outline"}>
                        {project.status}
                      </Badge>
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