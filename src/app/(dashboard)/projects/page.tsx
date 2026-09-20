import Link from "next/link"
import { api } from "@/components/dashboard/data"
import { NewProjectDialog } from "@/components/dashboard/new-project-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { FolderGit2Icon, FileCode2Icon, BracesIcon, BoxesIcon, CircleXIcon, GitBranchIcon, ExternalLinkIcon } from "lucide-react"
import type { ProjectDto } from "@/components/dashboard/types"
import { formatNumber, formatRelative } from "@/components/dashboard/types"

interface ProjectsResponse {
  projects: ProjectDto[]
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  synced: "outline",
  syncing: "default",
  created: "secondary",
  error: "destructive",
}

function CellStat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${label}: ${value}`}>
      {icon}
      {formatNumber(value)}
    </span>
  )
}

export default async function ProjectsPage() {
  const { projects } = await api<ProjectsResponse>("/api/v1/projects?includeStats=true")

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Repositories indexed by this Repotrace instance.
          </p>
        </div>
        <NewProjectDialog />
      </div>

      <Card>
        <CardContent className="p-0!">
          {projects.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <FolderGit2Icon className="size-6" />
              <p className="text-sm">No projects yet. Create one to start indexing a repository.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead className="text-right">Files</TableHead>
                  <TableHead className="text-right">Symbols</TableHead>
                  <TableHead className="text-right">Chunks</TableHead>
                  <TableHead>Last indexed</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <FolderGit2Icon className="size-4 text-muted-foreground" />
                        <div className="min-w-0">
                          <Link href={`/projects/${project.slug}`} className="font-medium hover:underline">
                            {project.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">{project.slug}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground" title={project.repoUrl}>
                      <span className="inline-flex items-center gap-1">
                        <ExternalLinkIcon className="size-3.5" />
                        {project.repoUrl}
                      </span>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      <CellStat icon={<FileCode2Icon />} value={project.stats?.files ?? 0} label="Files" />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      <CellStat icon={<BracesIcon />} value={project.stats?.symbols ?? 0} label="Symbols" />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      <CellStat icon={<BoxesIcon />} value={project.stats?.chunks ?? 0} label="Chunks" />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelative(project.repository?.lastSuccessfulSync)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[project.status] ?? "outline"}>{project.status}</Badge>
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