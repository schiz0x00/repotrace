"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RefreshCwIcon, RotateCcwIcon, ChevronDownIcon, Loader2Icon, Trash2Icon } from "lucide-react"
import { postAction } from "@/components/dashboard/dashboard-helpers"
import type { ProjectDto } from "@/components/dashboard/types"

// `postAction`/`deleteProject` moved to dashboard-helpers so their error
// handling can be unit tested; re-exported here to keep one import path.
export { deleteProject, postAction } from "@/components/dashboard/dashboard-helpers"

const REINDEX_OPTIONS = [
  { type: "full", label: "Full reindex" },
  { type: "incremental", label: "Incremental" },
  { type: "reembed", label: "Re-embed" },
]

export function ProjectActions({ project }: { project: ProjectDto }) {
  const [busy, setBusy] = React.useState<string | null>(null)

  const run = async (path: string, label: string, body?: Record<string, unknown>) => {
    setBusy(label)
    // try/finally even though `postAction` no longer rejects: it folds transport
    // failures into `{ ok: false }`, but leaving the state reset in a finally
    // is what guarantees Sync/Reindex cannot get stuck disabled if that ever
    // changes.
    try {
      const result = await postAction(path, body)
      if (!result.ok) {
        toast.error(result.message ?? `${label} failed.`)
      } else {
        toast.success(`${label} queued.`)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy !== null}
        onClick={() => run(`/api/v1/projects/${project.slug}/sync`, "Sync")}
      >
        {busy === "Sync" ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon />}
        Sync
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="default" size="sm" disabled={busy !== null} />}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : <RotateCcwIcon />}
          Reindex
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {REINDEX_OPTIONS.map(({ type, label }) => (
            <DropdownMenuItem key={type} onClick={() => void run(`/api/v1/projects/${project.slug}/reindex`, label, { type })}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
