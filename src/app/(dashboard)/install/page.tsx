import { headers } from "next/headers"
import { MCPInstall } from "@/components/dashboard/mcp-install"

export const metadata = {
  title: "Install MCP — Repotrace",
}

export default async function InstallPage() {
  const h = await headers()
  const proto = h.get("x-forwarded-proto") ?? "http"
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const origin = `${proto}://${host}`.replace(/\/+$/, "")
  return <MCPInstall origin={origin} />
}