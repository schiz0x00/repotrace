import { api } from "@/components/dashboard/data"
import { JobsTable } from "@/components/dashboard/jobs-table"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  FolderGit2Icon,
  FileCode2Icon,
  BracesIcon,
  BoxesIcon,
  ListTodoIcon,
  CircleCheckIcon,
  OctagonXIcon,
  Clock3Icon,
} from "lucide-react"
import type { JobDto, MetricsResponse, ProjectDto } from "@/components/dashboard/types"
import { formatNumber } from "@/components/dashboard/types"

interface ProjectsResponse {
  projects: ProjectDto[]
}

interface JobsResponse {
  jobs: JobDto[]
  total: number
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
  tone?: "default" | "warning"
}) {
  const Icon = icon
  return (
    <Card className="flex-1!">
      <CardContent className="flex items-center justify-between gap-3!">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
          {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
        </div>
        <div className={`rounded-lg p-2 ${tone === "warning" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
          {Icon}
        </div>
      </CardContent>
    </Card>
  )
}

export default async function OverviewPage() {
  const [metrics, jobsRes, projectsRes] = await Promise.all([
    api<MetricsResponse>("/api/v1/metrics?hours=24"),
    api<JobsResponse>("/api/v1/jobs?limit=8"),
    api<ProjectsResponse>("/api/v1/projects?includeStats=true"),
  ])

  const projects = projectsRes.projects
  const files = projects.reduce((sum, p) => sum + (p.stats?.files ?? 0), 0)
  const symbols = projects.reduce((sum, p) => sum + (p.stats?.symbols ?? 0), 0)
  const chunks = projects.reduce((sum, p) => sum + (p.stats?.chunks ?? 0), 0)
  const activeJobs = projects.reduce((sum, p) => sum + (p.stats?.activeJobs ?? 0), 0)
  const failed = metrics.jobs.failed ?? 0
  const failedJobsHint = failed > 0 ? `${failed} failed` : undefined

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Indexed repositories and system activity over the last {metrics.windowHours} hours.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<FolderGit2Icon />} label="Projects" value={String(projects.length)} />
        <StatCard icon={<FileCode2Icon />} label="Files" value={formatNumber(files)} />
        <StatCard icon={<BracesIcon />} label="Symbols" value={formatNumber(symbols)} />
        <StatCard icon={<BoxesIcon />} label="Chunks" value={formatNumber(chunks)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard icon={<ListTodoIcon />} label="Jobs queued" value={String(metrics.jobs.queued ?? 0)} />
        <StatCard icon={<Clock3Icon />} label="Jobs running" value={String(activeJobs)} hint="across projects" />
        <StatCard
          icon={<OctagonXIcon />}
          label="Jobs failed"
          value={String(failed)}
          hint={failedJobsHint}
          tone={failed > 0 ? "warning" : "default"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent jobs</CardTitle>
          <CardDescription>Latest indexing and sync activity.</CardDescription>
        </CardHeader>
        <CardContent className="p-0!">
          {jobsRes.jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <CircleCheckIcon className="size-6" />
              <p className="text-sm">No jobs yet — index a project to get started.</p>
            </div>
          ) : (
            <JobsTable jobs={jobsRes.jobs} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}