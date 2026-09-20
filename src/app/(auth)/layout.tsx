import Link from "next/link"
import { Card } from "@/components/ui/card"
import { BoxIcon } from "lucide-react"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
        <BoxIcon className="size-5" />
        Repotrace
      </Link>
      <Card size="sm" className="w-full max-w-sm">
        {children}
      </Card>
    </div>
  )
}