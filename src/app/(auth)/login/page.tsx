"use client"

import * as React from "react"
import Link from "next/link"
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
import { Loader2Icon } from "lucide-react"

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get("next") ?? "/"
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const { error } = await authClient().signIn.email({ email, password })
    if (error) {
      setError(errorMessage(error))
      setPending(false)
      return
    }
    router.push(next)
  }

  return (
    <form onSubmit={onSubmit} className="gap-1.5! flex-col!">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back to Repotrace.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
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
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Link href="/forgot-password" className="text-sm text-muted-foreground hover:underline">
          Forgot your password?
        </Link>
      </CardContent>
      <CardFooter>
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Loader2Icon className="size-4 animate-spin" />}
          Sign in
        </Button>
      </CardFooter>
      <div className="px-4! py-2! text-sm text-muted-foreground">
        New to Repotrace?{" "}
        <Link href="/signup" className="text-foreground hover:underline">
          Create an account
        </Link>
      </div>
    </form>
  )
}