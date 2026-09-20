"use client"

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress, ProgressValue } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { jobTypeLabel } from "@/components/dashboard/jobs-table"
import { postAction } from "@/components/dashboard/project-actions"
import {
  ListTodoIcon,
  Loader2Icon,
  CircleAlertIcon,
  OctagonXIcon,
  RotateCcwIcon,
  Clock3Icon,
} from "lucide-react"
import type { JobDto } from "@/components/dashboard/types"
import { formatRelative, shortId } from "@/components/dashboard/types"

async function getJobs(status: string): Promise<{ jobs: JobDto[] }> {
  const params = new URLSearchParams({ limit: "100" })
  if (status) params.set("status", status)
  const res = await fetch(`/api/v1/jobs?${params}`)
  return res.json() as Promise<{ jobs: JobDto[] }>
}

export default function JobsPage() {
  const [status, setStatus] = React.useState("")
  const [jobs, setJobs] = React.useState<JobDto[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      setJobs((await getJobs(status)).jobs)
    } finally {
      setLoading(false)
    }
  }, [status])

  React.useEffect(() => {
    void load()
    const interval = setInterval(() => void load(), 5000)
    return () => clearInterval(interval)
  }, [load])

  const cancel = async (job: JobDto) => {
    const result = await postAction(`/api/v1/jobs/${job.id}/cancel`)
    if (result.ok) toast.success("Job cancelled.")
    else toast.error(result.message ?? "Could not cancel job.")
    void load()
  }

  const retry = async (job: JobDto) => {
    const result = await postAction(`/api/v1/jobs/${job.id}/retry`)
    if (result.ok) toast.success("Job re-queued.")
    else toast.error(result.message ?? "Could not retry job.")
    void load()
  }

  const filter = (value: string) => {
    setStatus(value)
    setLoading(true)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">Indexing and sync activity, refreshing every 5 seconds.</p>
      </div>

      <Card>
        <CardContent className="p-0!">
          <div className="flex items-center gap-2 px-3! py-2!">
            {["", "queued", "running", "completed", "failed", "cancelled"].map((value) => (
              <Button
                key={value}
                variant={status === value ? "default" : "ghost"}
                size="sm"
                onClick={() => filter(value)}
              >
                {value === "" ? "All" : value}
              </Button>
            ))}
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Clock3Icon className="size-3.5" />
              auto-refresh
            </span>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              <span className="text-sm">Loading jobs…</span>
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <ListTodoIcon className="size-6" />
              <p className="text-sm">No jobs{status ? ` with status "${status}"` : ""}.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-44">Progress</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{shortId(job.id)}</TableCell>
                    <TableCell>
                      {job.project ? (
                        <Link href={`/projects/${job.project.slug}`} className="hover:underline">
                          {job.project.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{jobTypeLabel(job.type)}</TableCell>
                    <TableCell>
                      <Badge variant={job.status === "failed" ? "destructive" : job.status === "running" ? "default" : job.status === "queued" ? "secondary" : "outline"}>
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="w-44">
                      {job.error && job.status === "failed" ? (
                        <Tooltip>
                          <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-destructive"><CircleAlertIcon />{job.progress}%</span>} />
                          <TooltipContent className="max-w-xs">{job.error}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Progress value={job.progress} className="w-44 gap-1.5!">
                          <ProgressValue className="text-xs" />
                        </Progress>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground" title={new Date(job.createdAt).toLocaleString()}>
                      {formatRelative(job.createdAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {job.startedAt && job.completedAt
                        ? formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
                        : "—"}
                    </TableCell>
                    <TableCell className="w-20 text-right">
                      {(job.status === "queued" || job.status === "running") && (
                        <Button size="icon-sm" variant="ghost" onClick={() => void cancel(job)} title="Cancel">
                          <OctagonXIcon />
                        </Button>
                      )}
                      {(job.status === "failed" || job.status === "cancelled") && (
                        <Button size="icon-sm" variant="ghost" onClick={() => void retry(job)} title="Retry">
                          <RotateCcwIcon />
                        </Button>
                      )}
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

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}