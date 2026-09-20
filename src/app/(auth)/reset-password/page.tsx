"use client"

import * as React from "react"
import Link from "next/link"
import { Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
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
import { Loader2Icon, LockKeyholeIcon } from "lucide-react"

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  )
}

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password !== confirm) {
      setError("Passwords do not match.")
      return
    }
    setPending(true)
    setError(null)
    const { error } = await authClient().resetPassword({ newPassword: password, token })
    if (error) {
      setError(errorMessage(error))
      setPending(false)
      return
    }
    router.push("/login")
  }

  if (!token) {
    return (
      <div className="gap-1.5! flex-col!">
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>This link is missing its reset token.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <LockKeyholeIcon className="size-4" />
          Use the link from the reset email, or request a new one.
        </CardContent>
        <CardFooter>
          <Link href="/forgot-password" className="w-full">
            <Button className="w-full" variant="outline">
              Request a new link
            </Button>
          </Link>
        </CardFooter>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="gap-1.5! flex-col!">
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
        <CardDescription>Choose a strong password you don&apos;t use elsewhere.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="At least 8 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          placeholder="Repeat your password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </CardContent>
      <CardFooter>
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Loader2Icon className="size-4 animate-spin" />}
          Update password
        </Button>
      </CardFooter>
    </form>
  )
}