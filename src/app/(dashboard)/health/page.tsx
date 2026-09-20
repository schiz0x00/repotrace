import { api } from "@/components/dashboard/data"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { CircleCheckIcon, OctagonXIcon, DatabaseIcon, BoxesIcon, ListTodoIcon, ZapIcon, FolderGit2Icon, ServerCogIcon } from "lucide-react"
import type { HealthResponse } from "@/components/dashboard/types"

interface CheckProps {
  icon: React.ReactNode
  name: string
  detail: string
  healthy: boolean
  error?: string
}

function Check({ icon, name, detail, healthy, error }: CheckProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {name}
          <Badge variant={healthy ? "outline" : "destructive"}>{healthy ? "pass" : "fail"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{detail}</p>
        {!healthy && error && <p className="mt-2 break-words font-mono text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}

export default async function HealthPage() {
  const health = await api<HealthResponse>("/api/v1/health")
  const checks = health.checks

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Health</h1>
          <Badge variant={health.status === "healthy" ? "outline" : "destructive"}>{health.status}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Repotrace v{health.version} · checked in {health.tookMs}ms.
        </p>
      </div>

      {health.status !== "healthy" && (
        <Alert variant="destructive">
          <OctagonXIcon />
          <AlertTitle>Some services are unhealthy</AlertTitle>
          <AlertDescription>Resolve the failing checks below before relying on search.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Check
          icon={<DatabaseIcon />}
          name="PostgreSQL"
          detail={checks.postgres.healthy ? "Connection ok." : "Connection failed."}
          healthy={checks.postgres.healthy}
          error={checks.postgres.error}
        />
        <Check
          icon={<BoxesIcon />}
          name="Qdrant"
          detail={checks.qdrant.healthy ? `Vector store reachable (v${checks.qdrant.version ?? "?"}).` : "Vector store unreachable."}
          healthy={checks.qdrant.healthy}
          error={checks.qdrant.error}
        />
        <Check
          icon={<ListTodoIcon />}
          name="Job queue"
          detail={`Redis queue ${checks.queue.healthy ? `ok (depth ${checks.queue.depth})` : "unreachable"}.`}
          healthy={checks.queue.healthy}
          error={checks.queue.error}
        />
        <Check
          icon={<ZapIcon />}
          name="Embedding API"
          detail={
            checks.embedding.configured
              ? checks.embedding.healthy
                ? "Embedding endpoint responding."
                : "Embedding endpoint not responding."
              : "Not configured — semantic search disabled."
          }
          healthy={checks.embedding.healthy}
          error={checks.embedding.error}
        />
        <Check
          icon={<FolderGit2Icon />}
          name="Repository sync"
          detail={`${checks.repositorySync.repositories} repositor${checks.repositorySync.repositories === 1 ? "y" : "ies"}, ${checks.repositorySync.failures} failing.`}
          healthy={checks.repositorySync.healthy}
        />
        <Check
          icon={<ServerCogIcon />}
          name="Workers"
          detail={`${checks.workers.activeJobs} active job${checks.workers.activeJobs === 1 ? "" : "s"}, ${checks.workers.recentCompleted} completed in the last 15m.`}
          healthy={checks.workers.activeJobs === 0 || checks.workers.recentCompleted > 0}
        />
      </div>
    </div>
  )
}