import Link from "next/link"
import { api } from "@/components/dashboard/data"
import { ProjectActions } from "@/components/dashboard/project-actions"
import { ProjectTabs } from "@/components/dashboard/project-tabs"
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
  const [projectRes, statsRes, indexStatusRes, jobsRes, webhookRes] = await Promise.all([
    api<{ project: ProjectDto }>(`/api/v1/projects/${slug}`),
    api<StatsResponse>(`/api/v1/projects/${slug}/stats`),
    api<IndexStatusResponse>(`/api/v1/projects/${slug}/index-status`),
    api<JobsResponse>(`/api/v1/jobs?project=${slug}&limit=10`),
    api<WebhookResponse>(`/api/v1/projects/${slug}/webhook`),
  ])

  const project = projectRes.project
  const stats = statsRes.stats
  const indexStatus = indexStatusRes.indexStatus

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
            Last indexed {formatRelative(indexStatus.lastSuccessfulSync)} · {indexStatus.embeddingModel ?? "default model"}
            {indexStatus.embeddingDimensions ? ` · ${indexStatus.embeddingDimensions}d` : ""}
          </div>
        </div>
        <ProjectActions project={project} />
      </div>

      <ProjectTabs
        slug={project.slug}
        stats={stats}
        indexStatus={indexStatus}
        recentJobs={jobsRes.jobs}
        webhook={webhookRes.webhook}
      />
    </div>
  )
}