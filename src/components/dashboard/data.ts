import { headers } from "next/headers"

const BASE = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "")

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const requestHeaders = await headers()
  const cookie = requestHeaders.get("cookie")
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      ...(cookie ? { cookie } : {}),
    },
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = await res.json()
      message = (body as { error?: { message?: string } }).error?.message ?? message
    } catch {
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}