import nodemailer from "nodemailer";
import { env } from "@/lib/env";

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  /** "smtp" when delivered via SMTP, "console" when logged (no SMTP configured). */
  transport: "smtp" | "console";
}

/**
 * Sends an email. When SMTP is not configured, the email is logged to the
 * console — acceptable for local development, never for production.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<SentMail> {
  const cfg = env();
  if (cfg.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
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
  console.log(`[mail:console] to=${to} subject="${subject}"\n${text}`);
  return { to, subject, text, transport: "console" };
}