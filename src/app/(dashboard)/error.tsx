"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { OctagonXIcon } from "lucide-react"
// The same validator the login page uses for `?next=`: a path that reaches this
// boundary came from the router, but it is still untrusted input, and sending it
// through one implementation keeps the open-redirect guard in a single place.
import { safeNext } from "@/app/(auth)/login/safe-next"

/**
 * Error boundary for every server-rendered dashboard page.
 *
 * These pages are server components that `await` the API before rendering, and
 * `api()` throws on any non-2xx. Without a boundary, an expired session (401) or
 * a transient 500 replaced every page with Next's generic "Application error"
 * screen — no navigation, no way back to sign in. The failure is reported
 * here instead: what happened, the digest that matches the server log, a retry
 * that re-fetches the segment, and a link that signs the user in again.
 */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  const pathname = usePathname()

  // The server log is the only place the original message survives in
  // production (server-component errors are forwarded with a generic message),
  // so the boundary is where it gets recorded on the client side too.
  React.useEffect(() => {
    console.error("[dashboard:error]", error)
  }, [error])

  const signInHref = `/login?next=${encodeURIComponent(safeNext(pathname))}`
  const router = useRouter()
  const [signingOut, setSigningOut] = React.useState(false)

  /**
   * Clears the session, then goes to the login page.
   *
   * A link alone is not enough, and the reason is a mismatch between two
   * things that each look right: the proxy decides "already signed in" from the
   * presence of a cookie, while the failure is that the session behind that
   * cookie no longer exists. A bare `<Link href="/login">` therefore bounced
   * straight back into this same error. Signing out first removes the cookie
   * before /login is requested, which is the only thing that actually changes
   * what the proxy decides.
   *
   * `refresh()` alongside the push drops the cached server-component payload,
   * which otherwise still describes the session that just ended.
   */
  const signOutAndRedirect = async () => {
    setSigningOut(true)
    try {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" })
    } catch {
      // A failed sign-out is still worth navigating: the login page is the
      // only place a session can be re-established, and if the cookie really
      // is gone the proxy will let it through.
    }
    router.push(signInHref)
    router.refresh()
  }

  return (
    <div className="flex flex-col items-center gap-4 py-16">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <OctagonXIcon className="size-5 text-destructive" />
            This page could not be loaded
          </CardTitle>
          <CardDescription>
            A signed-out session is the usual cause: the dashboard reads its data through the API, and every read
            fails once the session expires. Sign in again, or retry if the failure was temporary.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-destructive">{error.message}</p>
          {error.digest && (
            <p className="font-mono text-xs text-muted-foreground">
              Reference: <span className="font-mono">{error.digest}</span> — quote this when reporting the failure.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => retry()}>Try again</Button>
            {/* A plain link to /login is inert in exactly the case this
                boundary exists for. src/proxy.ts sends any request for /login
                to "/" when a session COOKIE is present, and the usual reason a
                dashboard page throws here is that the cookie is present but the
                session behind it is gone. So the link bounced straight back
                into the failure. Sign out first, which is what actually
                clears the condition, then land on the login page. */}
            <Button variant="outline" onClick={signOutAndRedirect} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out and sign in"}
            </Button>
            <Button variant="ghost" render={<Link href="/" />}>
              Back to overview
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
