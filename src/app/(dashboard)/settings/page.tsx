import { api } from "@/components/dashboard/data"
import { AccountSettings } from "@/components/dashboard/account-settings"
import type { ApiKeyDto, ProjectDto } from "@/components/dashboard/types"

interface ApiKeysResponse {
  apiKeys: ApiKeyDto[]
}

interface ProjectsResponse {
  projects: ProjectDto[]
}

export default async function SettingsPage() {
  const { apiKeys } = await api<ApiKeysResponse>("/api/v1/api-keys")
  const { projects } = await api<ProjectsResponse>("/api/v1/projects")
  return <AccountSettings apiKeys={apiKeys} projects={projects} />
}