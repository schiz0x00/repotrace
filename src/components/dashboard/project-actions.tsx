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
import type { ProjectDto } from "@/components/dashboard/types"

export async function postAction(path: string, body?: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    return { ok: false, message: (json as { error?: { message?: string } })?.error?.message ?? "Request failed." }
  }
  return { ok: true }
}

const REINDEX_OPTIONS = [
  { type: "full", label: "Full reindex" },
  { type: "incremental", label: "Incremental" },
  { type: "reembed", label: "Re-embed" },
]

export function ProjectActions({ project }: { project: ProjectDto }) {
  const [busy, setBusy] = React.useState<string | null>(null)

  const run = async (path: string, label: string, body?: Record<string, unknown>) => {
    setBusy(label)
    const result = await postAction(path, body)
    if (!result.ok) {
      toast.error(result.message ?? `${label} failed.`)
    } else {
      toast.success(`${label} queued.`)
    }
    setBusy(null)
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

export async function deleteProject(slug: string): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/v1/projects/${slug}`, { method: "DELETE" })
  if (!res.ok) {
    const json = await res.json().catch(() => null)
    return { ok: false, message: (json as { error?: { message?: string } })?.error?.message ?? "Delete failed." }
  }
  return { ok: true }
}