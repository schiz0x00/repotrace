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
import { LayoutDashboardIcon, FolderGit2Icon, SearchIcon, ListTodoIcon, BoxesIcon, HeartPulseIcon, SettingsIcon, CodeXmlIcon, Loader2Icon, PlugZapIcon } from "lucide-react"

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

  React.useEffect(() => {
    if (!open) return
    setProjects(null)
    fetch("/api/v1/projects")
      .then((res) => (res.ok ? res.json() : { projects: [] }) as Promise<{ projects: ProjectBrief[] }>)
      .then((body) => setProjects(body.projects))
      .catch(() => setProjects([]))
  }, [open])

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }

  return (
    <Command>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
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
            {projects === null ? (
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