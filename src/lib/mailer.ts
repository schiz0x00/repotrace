import nodemailer from "nodemailer";
import { env } from "@/lib/env";

/**
 * Whether an SMTP transport is configured.
 *
 * Checked by the auth route *before* handing a password-reset request to
 * better-auth, because better-auth dispatches the send in the background: a
 * mailer failure is swallowed, the request succeeds, and the user is told to
 * look for an email that was never sent. Refusing up front turns that into an
 * honest error.
 */
export function smtpConfigured(): boolean {
  return env().SMTP_HOST.trim().length > 0;
}

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  /** "smtp" when handed to an SMTP transport, "console" when written to stdout. */
  transport: "smtp" | "console";
}

/**
 * Sends an email.
 *
 * An SMTP transport is configured when `SMTP_HOST` is set to anything other
 * than whitespace — `SMTP_HOST=""` and `SMTP_HOST="  "` both count as unset, so
 * an operator cannot accidentally talk their way past the production guard by
 * quoting an empty value.
 *
 * When SMTP is *not* configured the message body — which for the only current
 * caller is a live password-reset link — would go to container logs. That is
 * acceptable in development and in tests, where the log is the delivery
 * mechanism, and unacceptable in production, where it is a credential leak into
 * whatever aggregates stdout. So the console path is gated on
 * `NODE_ENV !== "production"`; in production an unconfigured transport throws
 * instead of logging.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<SentMail> {
  const cfg = env();
  const host = cfg.SMTP_HOST.trim();
  if (host) {
    const transporter = nodemailer.createTransport({
      host,
      port: cfg.SMTP_PORT,
      // Port 465 is implicit TLS; 587 and friends are STARTTLS on a plain
      // socket. Getting this backwards is a connect timeout, not an error the
      // caller can read, so it is derived rather than configured.
      secure: cfg.SMTP_PORT === 465,
      // Some relays (MailHog, a local Postfix) need no credentials. Handing
      // nodemailer an auth object with empty strings makes it attempt an AUTH
      // exchange the relay will reject, so omit the field entirely instead.
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    });
    await transporter.sendMail({
      from: cfg.SMTP_FROM,
      to,
      subject,
      text,
    });
    return { to, subject, text, transport: "smtp" };
  }
  if (cfg.NODE_ENV === "production") {
    // Thrown, not logged. Nothing is written to stdout, so a live reset token
    // cannot reach whatever aggregates container logs.
    //
    // Note that this throw does NOT reach the user. better-auth calls
    // sendResetPassword through `runInBackgroundOrAwait`, so a rejection here is
    // swallowed and the request still answers "check your email" while no mail
    // is ever sent. That is why the auth route refuses password-reset requests
    // up front via {@link smtpConfigured} rather than relying on this.
    throw new Error(
      "SMTP_HOST is not configured; refusing to log outbound mail in production because it would expose password-reset tokens",
    );
  }
  console.log(`[mail:console] to=${to} subject="${subject}"\n${text}`);
  return { to, subject, text, transport: "console" };
}