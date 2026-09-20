"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { authClient } from "@/components/dashboard/auth-client";

export function AuthRedirect({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    authClient()
      .getSession()
      .then(({ data }) => {
        if (data?.user) {
          // Authed: redirect to dashboard only when on auth pages.
          const authPages = ["/login", "/signup", "/forgot-password", "/reset-password"];
          const isAuthPage = authPages.some(
            (p) => pathname === p || pathname.startsWith(p + "/"),
          );
          if (isAuthPage) {
            router.replace("/");
          }
        } else {
          // Not authed: redirect to auth on protected routes.
          const protectedPaths = ["/", "/projects", "/search", "/jobs", "/embeddings", "/health", "/install", "/settings"];
          const isProtected = protectedPaths.some(
            (p) => pathname === p || pathname.startsWith(p + "/"),
          );
          if (isProtected) {
            router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          }
        }
      })
      .catch(() => {});
  }, [pathname, router]);

  return <>{children}</>;
}
