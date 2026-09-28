import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { env } from "@/lib/env";
import { sendMail } from "@/lib/mailer";
import { prisma } from "@/lib/prisma";

/**
 * `USE_SECURE_COOKIES` is a boolean that defaults to `false`, so forwarding it
 * verbatim would pin every deployment to insecure cookies — including a TLS one
 * that never set the flag — and would strip the `__Secure-` cookie prefix that
 * better-auth adds when it infers HTTPS from the request or `BETTER_AUTH_URL`.
 * `undefined` hands the decision back to that inference; the flag can still
 * force it on explicitly.
 */
const secureCookies = env().USE_SECURE_COOKIES ? true : undefined;

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
    // better-auth only calls deleteUserSessions on reset when this is set
    // (api/routes/password.mjs). Without it a session cookie captured before
    // the reset keeps working — session cookies slide their 7-day expiry — so
    // resetting a compromised password would not evict the attacker.
    revokeSessionsOnPasswordReset: true,
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
    useSecureCookies: secureCookies,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "strict",
      // Spread rather than always assigning: an explicit `secure: false` would
      // override the inference better-auth made from the request protocol.
      ...(secureCookies ? { secure: true } : {}),
    },
  },
  user: {
    additionalFields: {
      // Reserved for future multi-user roles; no role checks exist in V1.
    },
  },
});