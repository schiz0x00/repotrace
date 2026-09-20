import Link from "next/link"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Progress, ProgressValue } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CircleAlertIcon } from "lucide-react"
import type { JobDto } from "@/components/dashboard/types"
import { formatRelative, shortId } from "@/components/dashboard/types"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  queued: "secondary",
  running: "default",
  completed: "outline",
  failed: "destructive",
  cancelled: "outline",
}

const TYPE_LABEL: Record<string, string> = {
  initial_index: "Initial index",
  incremental_index: "Incremental index",
  full_reindex: "Full reindex",
  reembed: "Re-embed",
  repository_sync: "Repository sync",
  delete_project: "Delete project",
}

export function jobTypeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ")
}

export function JobsTable({
  jobs,
  showProject = true,
}: {
  jobs: JobDto[]
  showProject?: boolean
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Job</TableHead>
          {showProject && <TableHead>Project</TableHead>}
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-40">Progress</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell className="font-mono text-xs text-muted-foreground">{shortId(job.id)}</TableCell>
            {showProject && (
              <TableCell>
                {job.project ? (
                  <Link href={`/projects/${job.project.slug}`} className="hover:underline">
                    {job.project.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
            )}
            <TableCell className="text-muted-foreground">{jobTypeLabel(job.type)}</TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[job.status] ?? "outline"}>{job.status}</Badge>
            </TableCell>
            <TableCell className="w-40">
              {job.error && job.status === "failed" ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-destructive"><CircleAlertIcon />{job.progress}%</span>} />
                  <TooltipContent className="max-w-xs">{job.error}</TooltipContent>
                </Tooltip>
              ) : (
                <Progress value={job.progress} className="w-40 gap-1.5!">
                  <ProgressValue className="text-xs" />
                </Progress>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground" title={new Date(job.createdAt).toLocaleString()}>
              {formatRelative(job.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}