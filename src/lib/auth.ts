import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { env } from "@/lib/env";
import { sendMail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";

export const auth = betterAuth({
  appName: "Repotrace",
  database: prismaAdapter(prisma(), {
    provider: "postgresql",
  }),
  baseURL: env().BETTER_AUTH_URL,
  secret: env().BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Password reset emails are sent through the configured SMTP transport
    // (or logged to the console in development).
    sendResetPassword: async ({ user, url }) => {
      await sendMail(
        user.email,
        "Reset your Repotrace password",
        `Reset your Repotrace password by visiting:\n${url}\n\nIf you did not request this, you can safely ignore this email.`,
      );
    },
  },
  advanced: {
    useSecureCookies: env().USE_SECURE_COOKIES,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: env().USE_SECURE_COOKIES,
    },
  },
  user: {
    additionalFields: {
      // Reserved for future multi-user roles; no role checks exist in V1.
    },
  },
});