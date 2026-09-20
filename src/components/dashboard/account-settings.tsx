"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { authClient } from "@/components/dashboard/auth-client"
import {
  UserRoundIcon,
  KeyRoundIcon,
  PlusIcon,
  CopyIcon,
  Trash2Icon,
  Loader2Icon,
  CircleCheckIcon,
  OctagonXIcon,
} from "lucide-react"
import type { ApiKeyDto, ProjectDto } from "@/components/dashboard/types"
import { formatRelative } from "@/components/dashboard/types"

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<T>
}

export function AccountSettings({ apiKeys, projects }: { apiKeys: ApiKeyDto[]; projects: ProjectDto[] }) {
  const [user, setUser] = React.useState<{ name?: string | null; email?: string | null; emailVerified?: boolean | null } | null>(null)
  const [keys, setKeys] = React.useState<ApiKeyDto[]>(apiKeys)
  const [created, setCreated] = React.useState<{ name: string; key: string; prefix: string } | null>(null)
  const [name, setName] = React.useState("")
  const [projectId, setProjectId] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    void authClient().getSession().then(({ data }) => setUser(data?.user ?? null)).catch(() => {})
  }, [])

  const createKey = async () => {
    setPending(true)
    setError(null)
    const res = await fetch("/api/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, projectId }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      setError((json as { error?: { message?: string } })?.error?.message ?? "Could not create API key.")
      setPending(false)
      return
    }
    const { apiKey } = (await res.json()) as { apiKey: { name: string; key: string; prefix: string } }
    setCreated(apiKey)
    setKeys((await getJson<{ apiKeys: ApiKeyDto[] }>("/api/v1/api-keys")).apiKeys)
    setName("")
    setProjectId(null)
    setPending(false)
  }

  const revoke = async (id: string) => {
    const res = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE" })
    if (!res.ok) {
      toast.error("Could not revoke key.")
      return
    }
    toast.success("API key revoked.")
    setKeys((await getJson<{ apiKeys: ApiKeyDto[] }>("/api/v1/api-keys")).apiKeys)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Account and machine credentials for MCP and API access.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3!">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <UserRoundIcon className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{user?.name ?? "—"}</div>
            <div className="text-sm text-muted-foreground">{user?.email ?? "—"}</div>
          </div>
          <Badge variant={user?.emailVerified === false ? "outline" : "secondary"} className="ml-auto">
            {user?.emailVerified === false ? "unverified" : "verified"}
          </Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>Machine credentials for the MCP server and REST API (Authorization: Bearer rt_…).</CardDescription>
        </CardHeader>
        <CardContent className="p-0!">
          {keys.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <KeyRoundIcon className="size-6" />
              <p className="text-sm">No API keys yet.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{key.keyPrefix}…</TableCell>
                    <TableCell className="text-muted-foreground">{key.project?.name ?? "All projects"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(key.createdAt)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(key.lastUsedAt)}</TableCell>
                    <TableCell>
                      <Badge variant={key.revokedAt ? "destructive" : "outline"}>{key.revokedAt ? "revoked" : "active"}</Badge>
                    </TableCell>
                    <TableCell className="w-20 text-right">
                      {!key.revokedAt && (
                        <Button size="icon-sm" variant="ghost" onClick={() => void revoke(key.id)} title="Revoke">
                          <Trash2Icon />
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

      <Dialog>
        <DialogTrigger render={<Button />}>
          <PlusIcon />
          Create API key
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>The key is shown only once. Store it somewhere safe.</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="flex flex-col gap-3">
              <Alert>
                <CircleCheckIcon />
                <AlertDescription>
                  Key <span className="font-medium">{created.name}</span> created. Copy it now — it won't be shown again.
                </AlertDescription>
              </Alert>
              <div className="flex items-center gap-2">
                <Input readOnly value={created.key} className="font-mono! text-xs!" />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void navigator.clipboard.writeText(created.key).then(() => toast.success("Key copied."))}
                  title="Copy key"
                >
                  <CopyIcon />
                </Button>
              </div>
              <DialogFooter showCloseButton>
                <Button onClick={() => setCreated(null)}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Label htmlFor="api-key-name">Name</Label>
              <Input id="api-key-name" required placeholder="e.g. CI pipeline" value={name} onChange={(event) => setName(event.target.value)} />
              <Label htmlFor="api-key-scope">Scope</Label>
              <Select value={projectId || null} onValueChange={(value) => setProjectId(value)}>
                <SelectTrigger className="w-full!">
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={null}>All projects</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <DialogFooter showCloseButton>
                <Button disabled={!name.trim() || pending} onClick={() => void createKey()}>
                  {pending && <Loader2Icon className="size-4 animate-spin" />}
                  Create key
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}