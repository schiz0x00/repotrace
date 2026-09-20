"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2Icon, ChevronDownIcon, PlusIcon } from "lucide-react"

const PROVIDERS = [
  { value: "generic", label: "Generic (http / ssh / file)" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "bitbucket", label: "Bitbucket" },
]

export function NewProjectDialog() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const reset = () => {
    setError(null)
    setPending(false)
  }

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const embedding = {
      provider: form.get("embeddingProvider") as string | undefined,
      apiUrl: (form.get("embeddingApiUrl") as string | undefined) ?? undefined,
      apiKey: (form.get("embeddingApiKey") as string | undefined) ?? undefined,
      model: form.get("embeddingModel") as string | undefined,
      dimensions: (form.get("embeddingDimensions") as string | undefined)
        ? Number(form.get("embeddingDimensions"))
        : undefined,
      batchSize: (form.get("embeddingBatchSize") as string | undefined)
        ? Number(form.get("embeddingBatchSize"))
        : undefined,
    }
    const credentials = (form.get("token") as string | undefined)?.trim()
    const body = {
      name: form.get("name") as string,
      description: (form.get("description") as string | undefined)?.trim() || null,
      repoUrl: form.get("repoUrl") as string,
      provider: form.get("provider") as string | undefined,
      defaultBranch: (form.get("defaultBranch") as string | undefined)?.trim() || undefined,
      credentials: credentials ? { token: credentials } : undefined,
      embedding: Object.values(embedding).some((v) => v !== undefined) ? embedding : undefined,
    }

    setPending(true)
    setError(null)
    const res = await fetch("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      setError((json as { error?: { message?: string } })?.error?.message ?? "Could not create project.")
      setPending(false)
      return
    }
    const { project } = (await res.json()) as { project: { slug: string } }
    await fetch(`/api/v1/projects/${project.slug}/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "initial" }),
    }).catch(() => {})
    toast.success(`Project "${project.slug}" created — indexing started.`)
    setOpen(false)
    setPending(false)
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={(value) => {
      setOpen(value)
      if (value) reset()
    }}>
      <DialogTrigger render={<Button />}>
        <PlusIcon />
        New project
      </DialogTrigger>
      <DialogContent className="max-h-full overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Index a git repository for semantic, lexical, and structural search.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required placeholder="Order Service" />
          <Label htmlFor="description">Description</Label>
          <Textarea id="description" name="description" rows={2} placeholder="Optional description" className="min-h-16!" />
          <Label htmlFor="repoUrl">Repository URL</Label>
          <Input
            id="repoUrl"
            name="repoUrl"
            required
            placeholder="https://github.com/acme/order-service or git@… or file:///path"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Provider</Label>
              <Select defaultValue="generic" name="provider">
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="defaultBranch">Default branch</Label>
              <Input id="defaultBranch" name="defaultBranch" placeholder="main" />
            </div>
          </div>
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="gap-1! text-muted-foreground" />}>
              <ChevronDownIcon />
              Optional credentials &amp; embedding overrides
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3 pt-2">
              <Label htmlFor="token">Access token</Label>
              <Input id="token" name="token" type="password" placeholder="For private repositories" autoComplete="off" />
              <Separator />
              <p className="text-xs text-muted-foreground">
                Leave blank to use the system-wide embedding configuration.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="embeddingProvider">Provider</Label>
                  <Input id="embeddingProvider" name="embeddingProvider" placeholder="e.g. openai" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="embeddingModel">Model</Label>
                  <Input id="embeddingModel" name="embeddingModel" placeholder="e.g. text-embedding-3-small" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="embeddingApiUrl">API URL</Label>
                  <Input id="embeddingApiUrl" name="embeddingApiUrl" type="url" placeholder="https://…/v1" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="embeddingApiKey">API key</Label>
                  <Input id="embeddingApiKey" name="embeddingApiKey" type="password" autoComplete="off" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="embeddingDimensions">Dimensions</Label>
                  <Input id="embeddingDimensions" name="embeddingDimensions" type="number" min={1} max={8192} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="embeddingBatchSize">Batch size</Label>
                  <Input id="embeddingBatchSize" name="embeddingBatchSize" type="number" min={1} max={512} />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
          <DialogFooter showCloseButton>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="size-4 animate-spin" />}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}