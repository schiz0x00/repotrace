"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { LayoutDashboardIcon, FolderGit2Icon, SearchIcon, ListTodoIcon, BoxesIcon, HeartPulseIcon, SettingsIcon, CodeXmlIcon, Loader2Icon, PlugZapIcon, TriangleAlertIcon } from "lucide-react"
import { getJson } from "@/components/dashboard/dashboard-helpers"

const NAV_ACTIONS = [
  { href: "/", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/projects", label: "Projects", icon: FolderGit2Icon },
  { href: "/search", label: "Search", icon: SearchIcon },
  { href: "/jobs", label: "Jobs", icon: ListTodoIcon },
  { href: "/embeddings", label: "Embeddings", icon: BoxesIcon },
  { href: "/health", label: "Health", icon: HeartPulseIcon },
  { href: "/install", label: "Install", icon: PlugZapIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
]

interface ProjectBrief {
  slug: string
  name: string
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [projects, setProjects] = React.useState<ProjectBrief[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    // getJson checks res.ok and throws the API's message. The previous
    // `res.ok ? res.json() : { projects: [] }` turned every 401/500 into an
    // empty list, so an expired session rendered "No projects yet" — the same
    // false story the search page had.
    getJson<{ projects: ProjectBrief[] }>("/api/v1/projects")
      .then((body) => {
        if (cancelled) return
        setProjects(body.projects)
        setError(null)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setProjects([])
        setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setProjects(null)
      setError(null)
    }
    onOpenChange(next)
  }

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }

  return (
    <Command>
      <CommandDialog open={open} onOpenChange={handleOpenChange}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Navigation">
            {NAV_ACTIONS.map(({ href, label, icon: Icon }) => (
              <CommandItem key={href} onSelect={() => go(href)}>
                <Icon />
                Go to {label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Projects">
            {error ? (
              <CommandItem disabled>
                <TriangleAlertIcon />
                Could not load projects: {error}
              </CommandItem>
            ) : projects === null ? (
              <CommandItem disabled>
                <Loader2Icon className="size-4 animate-spin" />
                Loading projects…
              </CommandItem>
            ) : projects.length === 0 ? (
              <CommandItem disabled>
                <FolderGit2Icon />
                No projects yet
              </CommandItem>
            ) : (
              projects.map((p) => (
                <CommandItem key={p.slug} onSelect={() => go(`/search?project=${p.slug}`)}>
                  <CodeXmlIcon />
                  Search code in {p.name}
                  <CommandShortcut>{p.slug}</CommandShortcut>
                </CommandItem>
              ))
            )}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </Command>
  )
}