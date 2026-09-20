"use client"

import { createAuthClient } from "better-auth/client"

let _client: ReturnType<typeof createAuthClient> | null = null

export function authClient() {
  _client ??= createAuthClient({ baseURL: `${window.location.origin}/api/auth` })
  return _client
}

export function errorMessage(error: unknown): string {
  if (!error) return "Something went wrong. Please try again."
  const e = error as { message?: string; error?: unknown }
  if (typeof e.message === "string" && e.message) return e.message
  const body = e.error
  if (body && typeof body === "object") {
    const b = body as { message?: string; error?: { message?: string } }
    if (typeof b.message === "string" && b.message) return b.message
    if (b.error?.message) return b.error.message
  }
  return "Something went wrong. Please try again."
}