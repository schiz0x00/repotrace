"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { CommandPalette } from "@/components/dashboard/command-palette"
import { authClient } from "@/components/dashboard/auth-client"
import { initials } from "@/components/dashboard/types"
import {
  LayoutDashboardIcon,
  FolderGit2Icon,
  SearchIcon,
  ListTodoIcon,
  BoxesIcon,
  HeartPulseIcon,
  SettingsIcon,
  LogOutIcon,
  KeyRoundIcon,
  BoxIcon,
  SearchCodeIcon,
  PlugZapIcon,
} from "lucide-react"

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/projects", label: "Projects", icon: FolderGit2Icon },
  { href: "/search", label: "Search", icon: SearchIcon },
  { href: "/jobs", label: "Jobs", icon: ListTodoIcon },
  { href: "/embeddings", label: "Embeddings", icon: BoxesIcon },
  { href: "/health", label: "Health", icon: HeartPulseIcon },
  { href: "/install", label: "Install", icon: PlugZapIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
]

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [user, setUser] = React.useState<{ name?: string | null; email?: string | null } | null>(null)

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  React.useEffect(() => {
    void authClient().getSession().then(({ data }) => setUser(data?.user ?? null)).catch(() => {})
  }, [])

  const signOut = async () => {
    try {
      await authClient().signOut()
    } catch {
    }
    window.location.href = "/login"
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="p-2!">
          <SidebarMenuButton
            render={<Link href="/" />}
            size="lg"
            className="gap-2.5! font-semibold! rounded-lg! px-2.5! group-data-[collapsible=icon]:justify-center"
          >
            <BoxIcon className="size-5!" />
            <span className="group-data-[collapsible=icon]:hidden">Repotrace</span>
          </SidebarMenuButton>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {NAV.map(({ href, label, icon: Icon }) => (
                  <SidebarMenuItem key={href}>
                    <SidebarMenuButton
                      isActive={isActive(pathname, href)}
                      onClick={() => router.push(href)}
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu className="gap-1">
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => router.push("/settings")} isActive={isActive(pathname, "/settings")}>
                <KeyRoundIcon />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="gap-4">
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-2 border-b bg-background/80 px-4 supports-backdrop-filter:backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Button
              variant="ghost"
              onClick={() => setPaletteOpen(true)}
              className="w-full max-w-60 justify-start text-muted-foreground sm:w-60"
            >
              <SearchCodeIcon />
              <span className="flex-1 text-left">Search…</span>
              <kbd className="rounded-md border bg-muted px-1.5 text-[0.7rem] font-sans text-muted-foreground">⌘K</kbd>
            </Button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" className="rounded-full! p-0!" />
              }
            >
              <Avatar className="size-7!">
                <AvatarFallback>{initials(user?.name ?? user?.email ?? "?")}</AvatarFallback>
              </Avatar>
              <span className="sr-only">Account menu</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">
                  {user?.name ?? "Signed in"}
                  <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/settings")}>
                <SettingsIcon />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={signOut}>
                <LogOutIcon />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="flex-1 overflow-x-hidden px-4 pb-10">{children}</main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  )
}