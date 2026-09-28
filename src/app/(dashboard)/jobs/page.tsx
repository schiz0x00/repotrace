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
import { createRequestGate } from "@/components/dashboard/dashboard-helpers"
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
  // The response was cast straight to the success shape without checking
  // res.ok, so a 401 or 500 set `jobs` to undefined and the render threw —
  // and because the page polls every 5 seconds, it threw again immediately,
  // forever. An expired session looked like a permanently broken page.
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `Could not load jobs (HTTP ${res.status})`)
  }
  return res.json() as Promise<{ jobs: JobDto[] }>
}

export default function JobsPage() {
  const [status, setStatus] = React.useState("")
  const [jobs, setJobs] = React.useState<JobDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Generation counter for the poll. Changing the filter swaps `status` and
  // re-keys `load`, but the request the previous filter started is still in
  // flight, and so is the 5s tick that fired just before the change. Responses
  // are not ordered: a slow `?status=` request for the old filter can land
  // after a fast one for the new filter and repopulate the table with jobs the
  // operator just filtered out — a table that looks right for a filter that is
  // no longer selected. Each request takes a ticket; only the newest ticket may
  // write state.
  const [gate] = React.useState(createRequestGate)

  // `load` never calls setState synchronously: everything happens in the
  // promise callbacks, so polling this every 5 seconds cannot cascade a
  // render on the tick itself.
  const load = React.useCallback(
    () => {
      const requestId = gate.next()
      return getJobs(status)
        .then((data) => {
          if (!gate.isCurrent(requestId)) return
          setJobs(data.jobs)
          setError(null)
        })
        .catch((err: Error) => {
          // Swallowed here it became an unhandled rejection on every poll tick.
          if (!gate.isCurrent(requestId)) return
          setError(err.message)
        })
        .finally(() => {
          if (!gate.isCurrent(requestId)) return
          setLoading(false)
        })
    },
    [status, gate],
  )

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
          ) : jobs.length === 0 && error ? (
            // Nothing loaded AND the load failed: this is the only case where
            // the table has nothing to show. Once a poll has succeeded, a later
            // failure must not blank a working table -- the jobs are real, they
            // are just not being refreshed, and replacing them with an error
            // told the operator their job history had vanished.
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <OctagonXIcon className="size-6 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
              <p className="text-sm text-muted-foreground">
                The job list could not be loaded. Reload to try again.
              </p>
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <ListTodoIcon className="size-6" />
              <p className="text-sm">No jobs{status ? ` with status "${status}"` : ""}.</p>
            </div>
          ) : (
            <React.Fragment>
          {error && (
            // A stale-but-real table plus a visible warning beats either
            // pretending the data is current or throwing it away.
            <div className="flex items-center gap-2 border-b px-6 py-2 text-sm text-destructive">
              <OctagonXIcon className="size-4 shrink-0" />
              <span>
                Showing the last successful load. Refreshing failed: {error}
              </span>
            </div>
          )}
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
          </React.Fragment>
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