"use client"

import * as React from "react"
import Link from "next/link"
import { authClient, errorMessage } from "@/components/dashboard/auth-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CircleCheckIcon, Loader2Icon } from "lucide-react"

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [sent, setSent] = React.useState(false)

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const { error } = await authClient().requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error) {
      setError(errorMessage(error))
      setPending(false)
      return
    }
    setSent(true)
    setPending(false)
  }

  return (
    <form onSubmit={onSubmit} className="gap-1.5! flex-col!">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>We'll email you a link to set a new password.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sent ? (
          <Alert>
            <CircleCheckIcon />
            <AlertDescription>
              If an account exists for <span className="font-medium">{email}</span>, a reset link is on its way.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </>
        )}
      </CardContent>
      {!sent && (
        <CardFooter>
          <Button type="submit" disabled={pending} className="w-full">
            {pending && <Loader2Icon className="size-4 animate-spin" />}
            Send reset link
          </Button>
        </CardFooter>
      )}
      <div className="px-4! py-2! text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link href="/login" className="text-foreground hover:underline">
          Sign in
        </Link>
      </div>
    </form>
  )
}