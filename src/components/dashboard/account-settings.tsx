"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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
import { getJson } from "@/components/dashboard/dashboard-helpers"
import {
  UserRoundIcon,
  KeyRoundIcon,
  PlusIcon,
  CopyIcon,
  Trash2Icon,
  Loader2Icon,
  CircleCheckIcon,
  MonitorIcon,
  LogOutIcon,
} from "lucide-react"
import type { ApiKeyDto, ProjectDto } from "@/components/dashboard/types"
import { formatRelative } from "@/components/dashboard/types"

/** One active session, serialized for the client. */
export interface SessionDto {
  id: string
  current: boolean
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  lastActiveAt: string
  expiresAt: string
}

/** Argument of the revoke server function; kept in sync with the page's zod schema. */
export type RevokeTarget = { kind: "session"; sessionId: string } | { kind: "others" }

export interface RevokeResult {
  ok: boolean
  error?: string
}

/**
 * Best-effort human label for a user-agent string. Sessions are also useful
 * when the user agent is absent or unrecognised, so the raw string is the
 * fallback rather than hiding the row.
 */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device"
  const lower = ua.toLowerCase()
  const os = lower.includes("windows")
    ? "Windows"
    : /iphone|ipad|ipod/.test(lower)
      ? "iOS"
      : lower.includes("android")
        ? "Android"
        : lower.includes("mac os") || lower.includes("macintosh")
          ? "macOS"
          : lower.includes("linux")
            ? "Linux"
            : null
  const browser = lower.includes("edg/")
    ? "Edge"
    : lower.includes("opr/") || lower.includes("opera")
      ? "Opera"
      : lower.includes("firefox/")
        ? "Firefox"
        : lower.includes("chrome/") || lower.includes("chromium")
          ? "Chrome"
          : lower.includes("safari/")
            ? "Safari"
            : lower.startsWith("curl/")
              ? "curl"
              : lower.startsWith("wget/")
                ? "wget"
                : /bot|crawler|spider/.test(lower)
                  ? "bot"
                  : null
  if (browser && os) return `${browser} on ${os}`
  const label = browser ?? os
  if (label) return label
  return ua.length > 60 ? `${ua.slice(0, 60)}…` : ua
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Key copied.")
  } catch {
    toast.error("Could not copy — your browser blocked clipboard access.")
  }
}

export function AccountSettings({
  apiKeys,
  projects,
  sessions,
  revokeSessions,
}: {
  apiKeys: ApiKeyDto[]
  projects: ProjectDto[]
  sessions: SessionDto[]
  revokeSessions: (target: RevokeTarget) => Promise<RevokeResult>
}) {
  const [user, setUser] = React.useState<{ name?: string | null; email?: string | null; emailVerified?: boolean | null } | null>(null)
  // "unknown" until the session read resolves. It has to be tracked separately
  // from `user === null`, because a null user is also what a *failed* read
  // leaves behind: without this the badge below, which tests
  // `emailVerified === false` and renders "verified" for everything else,
  // labelled the account verified on the strength of a request that threw.
  const [sessionState, setSessionState] = React.useState<"loading" | "loaded" | "failed">("loading")
  const [keys, setKeys] = React.useState<ApiKeyDto[]>(apiKeys)
  const [created, setCreated] = React.useState<{ name: string; key: string; prefix: string } | null>(null)
  const [name, setName] = React.useState("")
  const [projectId, setProjectId] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [revoking, setRevoking] = React.useState(false)
  const router = useRouter()

  React.useEffect(() => {
    let active = true
    authClient()
      .getSession()
      .then(({ data }) => {
        if (!active) return
        setUser(data?.user ?? null)
        setSessionState("loaded")
      })
      .catch(() => {
        // No toast: this read only fills in the name/email/verification badge,
        // and the rest of the page works from server-rendered data. The badge
        // itself says the state is unknown, which is the honest outcome.
        if (active) setSessionState("failed")
      })
    return () => {
      active = false
    }
  }, [])

  const createKey = async () => {
    setPending(true)
    setError(null)
    // try/finally: the refresh below used to run outside any error handling, so
    // a failed list refresh left the Create button disabled forever.
    try {
      const res = await fetch("/api/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, projectId }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setError((json as { error?: { message?: string } })?.error?.message ?? "Could not create API key.")
        return
      }
      const { apiKey } = (await res.json()) as { apiKey: { name: string; key: string; prefix: string } }
      setCreated(apiKey)
      setName("")
      setProjectId(null)
      // The key exists at this point, so a failed refresh is reported as a
      // refresh failure — the dialog now shows the new key, not the form, so
      // this cannot go through `error` without being invisible.
      try {
        setKeys((await getJson<{ apiKeys: ApiKeyDto[] }>("/api/v1/api-keys")).apiKeys)
      } catch (err) {
        toast.error(`Key created, but the list could not be refreshed: ${(err as Error).message}`)
      }
    } catch (err) {
      setError(`Could not create API key: ${(err as Error).message}`)
    } finally {
      setPending(false)
    }
  }

  const revoke = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE" })
      if (!res.ok) {
        toast.error("Could not revoke key.")
        return
      }
    } catch (err) {
      // A transport failure here means the DELETE's outcome is unknown, so it
      // is a genuine revoke failure, not a refresh failure.
      toast.error(`Could not revoke key: ${(err as Error).message}`)
      return
    }
    // Same split as createKey, and the reason for the two blocks: the DELETE
    // has already succeeded, so a failed relist below is reported as a refresh
    // failure and never as a failed revoke.
    try {
      const { apiKeys } = await getJson<{ apiKeys: ApiKeyDto[] }>("/api/v1/api-keys")
      setKeys(apiKeys)
    } catch (err) {
      toast.error(`Key revoked, but the list could not be refreshed: ${(err as Error).message}`)
      return
    }
    toast.success("API key revoked.")
  }

  // The session list is server-rendered, so the refreshed props replace it
  // after a successful revoke rather than a local copy drifting out of sync.
  const endSession = async (target: RevokeTarget) => {
    setRevoking(true)
    // try/catch/finally, not a straight-line call: `revokeSessions` is a server
    // function and can reject (network drop, navigation, a thrown error before
    // it converts to a result). Without this the rejection was unhandled and
    // `setRevoking(false)` was never reached, so every session-revoke control on
    // the page stayed disabled for the rest of the visit with no message shown.
    try {
      const result = await revokeSessions(target)
      if (!result.ok) {
        toast.error(result.error ?? "Could not revoke session.")
        return
      }
      toast.success(target.kind === "others" ? "Other sessions revoked." : "Session revoked.")
      router.refresh()
    } catch (err) {
      toast.error(`Could not revoke session: ${(err as Error).message}`)
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Account, active sessions and machine credentials for MCP and API access.</p>
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
          {/* Three states, not two: while the read is in flight and after it
              has failed, whether the address is verified is not known, and
              "verified" is a security-relevant claim the component cannot
              back. `user` being null on a *successful* read does mean
              unverified (no session), so the two nulls are distinguished by
              `sessionState` rather than by `user` alone. */}
          <Badge
            variant={sessionState === "loaded" && user?.emailVerified !== false ? "secondary" : "outline"}
            className="ml-auto"
          >
            {sessionState === "loading"
              ? "checking…"
              : sessionState === "failed"
                ? "verification unknown"
                : user?.emailVerified === false
                  ? "unverified"
                  : "verified"}
          </Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Every browser currently signed in to this account. Revoke anything you don&apos;t recognise.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0!">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <MonitorIcon className="size-6" />
              <p className="text-sm">No active sessions.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Signed in</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-28 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">
                      {describeUserAgent(session.userAgent)}
                      {session.current && (
                        <Badge variant="secondary" className="ml-2 align-middle">
                          this device
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{session.ipAddress ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(session.createdAt)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(session.lastActiveAt)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(session.expiresAt)}</TableCell>
                    <TableCell className="text-right">
                      {!session.current && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={revoking}
                          onClick={() => void endSession({ kind: "session", sessionId: session.id })}
                          title="Revoke session"
                        >
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
        {sessions.length > 1 && (
          <CardFooter className="justify-end">
            <Button variant="outline" disabled={revoking} onClick={() => void endSession({ kind: "others" })}>
              {revoking ? <Loader2Icon className="size-4 animate-spin" /> : <LogOutIcon className="size-4" />}
              Sign out other sessions
            </Button>
          </CardFooter>
        )}
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
                  Key <span className="font-medium">{created.name}</span> created. Copy it now — it won&apos;t be shown again.
                </AlertDescription>
              </Alert>
              <div className="flex items-center gap-2">
                <Input readOnly value={created.key} className="font-mono! text-xs!" />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void copyToClipboard(created.key)}
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