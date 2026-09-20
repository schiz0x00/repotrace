import { DashboardShell } from "@/components/dashboard/shell"
import OverviewPage from "./(dashboard)/page"

export default function RootPage() {
  return (
    <DashboardShell>
      <OverviewPage />
    </DashboardShell>
  )
}
