import Link from "next/link"
import { env } from "@/lib/env"
import { api } from "@/components/dashboard/data"
import { ProjectActions } from "@/components/dashboard/project-actions"
import { ProjectTabs, type WebhookSecretSource } from "@/components/dashboard/project-tabs"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { ExternalLinkIcon, GitBranchIcon } from "lucide-react"
import type { IndexStatus, JobDto, ProjectDto, ProjectStats, WebhookInfo } from "@/components/dashboard/types"
import { formatRelative } from "@/components/dashboard/types"

interface StatsResponse {
  stats: ProjectStats
}

interface IndexStatusResponse {
  indexStatus: IndexStatus
}

interface JobsResponse {
  jobs: JobDto[]
}

interface WebhookResponse {
  webhook: WebhookInfo
}

export default async function ProjectDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const [projectRes, statsRes, jobsRes, webhookRes, indexStatusResult] = await Promise.all([
    api<{ project: ProjectDto }>(`/api/v1/projects/${slug}`),
    api<StatsResponse>(`/api/v1/projects/${slug}/stats`),
    api<JobsResponse>(`/api/v1/jobs?project=${slug}&limit=10`),
    api<WebhookResponse>(`/api/v1/projects/${slug}/webhook`),
    // The index-status read is isolated from the rest: it is the one call that
    // can fail for reasons that have nothing to do with the page being
    // viewable (a Qdrant collection that cannot be reached, a 500 from the
    // status route). Letting it reject took the whole page down with it, and
    // the alternative — treating a failed read as a status of "no model
    // recorded" — rendered the system default and left the project looking
    // healthy. The failure is carried alongside and shown as unknown.
    api<IndexStatusResponse>(`/api/v1/projects/${slug}/index-status`).then(
      (res) => ({ indexStatus: res.indexStatus, indexStatusError: null as string | null }),
      (err: unknown) => ({
        indexStatus: null,
        indexStatusError: err instanceof Error ? err.message : "The index status request failed.",
      }),
    ),
  ])

  const project = projectRes.project
  const stats = statsRes.stats
  const { indexStatus, indexStatusError } = indexStatusResult
  // `webhookSecretFor()` prefers the process-wide GITHUB_WEBHOOK_SECRET over the
  // per-project secret the webhook endpoint hands out, so the settings tab has
  // to say which one is actually in force. The global value itself is not sent
  // to the browser: it authorises delivery for every project on the instance.
  const webhookSecretSource: WebhookSecretSource = env().GITHUB_WEBHOOK_SECRET ? "global" : "project"

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/projects" />}>Projects</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{project.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{project.name}</h1>
            <Badge variant={project.status === "error" ? "destructive" : project.status === "syncing" ? "default" : "outline"}>
              {project.status}
            </Badge>
            {project.repository?.syncError && (
              <Badge variant="destructive">sync error</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex max-w-full items-center gap-1 truncate" title={project.repoUrl}>
              <ExternalLinkIcon className="size-3.5" />
              {project.repoUrl}
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <GitBranchIcon className="size-3.5" />
              {project.defaultBranch}
            </span>
            {project.description && (
              <>
                <span>·</span>
                <span className="truncate">{project.description}</span>
              </>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {indexStatus === null ? (
              // Same rule as the tabs below: an unreadable status is not a
              // status. "default model" here would read as a verified claim
              // about an index nobody has managed to inspect.
              <>Index status unreadable — last sync and embedding model are unknown{indexStatusError ? `: ${indexStatusError}` : "."}</>
            ) : (
              <>
                Last indexed {formatRelative(indexStatus.lastSuccessfulSync)} · {indexStatus.embeddingModel ?? "default model"}
                {indexStatus.embeddingDimensions ? ` · ${indexStatus.embeddingDimensions}d` : ""}
              </>
            )}
          </div>
        </div>
        <ProjectActions project={project} />
      </div>

      <ProjectTabs
        slug={project.slug}
        stats={stats}
        indexStatus={indexStatus}
        indexStatusError={indexStatusError}
        recentJobs={jobsRes.jobs}
        webhook={webhookRes.webhook}
        webhookSecretSource={webhookSecretSource}
        // The settings form edits the per-project embedding override. It was
        // previously handed a hardcoded all-null object, so the form always
        // rendered empty: an operator could not see or edit a project's
        // override, and saving appeared to do nothing.
        embedding={project.embedding}
      />
    </div>
  )
}