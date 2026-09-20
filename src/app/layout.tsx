import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import { AuthRedirect } from "@/components/auth-redirect";
import "./globals.css";

export const metadata: Metadata = {
  title: "Repotrace",
  description: "Self-hosted code intelligence for git repositories",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full flex flex-col">
        <AuthRedirect>{children}</AuthRedirect>
        <Toaster />
      </body>
    </html>
  );
}