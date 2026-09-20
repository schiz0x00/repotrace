"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
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

export default function SignupPage() {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const { error } = await authClient().signUp.email({ name, email, password })
    if (error) {
      setError(errorMessage(error))
      setPending(false)
      return
    }
    router.push("/")
  }

  return (
    <form onSubmit={onSubmit} className="gap-1.5! flex-col!">
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Set up a self-hosted Repotrace instance for your repositories.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          required
          placeholder="Ada Lovelace"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
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
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="At least 8 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </CardContent>
      <CardFooter>
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Loader2Icon className="size-4 animate-spin" />}
          Create account
        </Button>
      </CardFooter>
      <div className="px-4! py-2! text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="text-foreground hover:underline">
          Sign in
        </Link>
      </div>
    </form>
  )
}