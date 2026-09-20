import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

/**
 * GitHub webhook signature validation. Two secret modes are supported:
 *  - GITHUB_WEBHOOK_SECRET env var (global secret for all repositories)
 *  - per-project deterministic secret (HMAC of BETTER_AUTH_SECRET + project
 *    id), surfaced in the project's webhook settings
 * GitHub computes the signature over the raw request body, so callers must
 * pass the unparsed body bytes.
 */

const HEADER = "x-hub-signature-256";

/** Per-project secret shown in the project webhook settings. */
export function generateWebhookSecret(projectId: string): string {
  const cfg = env();
  return createHmac("sha256", cfg.BETTER_AUTH_SECRET)
    .update(`webhook:${projectId}`)
    .digest("hex");
}

/** Returns the secret configured for a project (global env takes precedence). */
export function webhookSecretFor(projectId: string): string {
  const global = env().GITHUB_WEBHOOK_SECRET;
  return global || generateWebhookSecret(projectId);
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer | string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GithubPushEvent {
  ref: string;
  after: string;
  before: string;
  repository?: {
    full_name?: string;
    html_url?: string;
    clone_url?: string;
    default_branch?: string;
  };
  pusher?: { name?: string; email?: string };
  head_commit?: { message?: string; timestamp?: string; author?: { name?: string } } | null;
}

/** Finds the project a push event belongs to, by repository URL or name. */
export async function projectForPushEvent(event: GithubPushEvent): Promise<{ id: string; branch: string } | null> {
  const urls = [
    event.repository?.html_url,
    event.repository?.clone_url,
    event.repository?.full_name ? `https://github.com/${event.repository.full_name}` : undefined,
    event.repository?.full_name ? `git@github.com:${event.repository.full_name}.git` : undefined,
  ].filter(Boolean) as string[];

  for (const url of urls) {
    const project = await prisma().project.findFirst({
      where: { repoUrl: url },
      select: { id: true, defaultBranch: true },
    });
    if (project) return { id: project.id, branch: project.defaultBranch };
  }
  // Fallback: match by repo URL suffix (https vs .git normalization).
  for (const url of urls) {
    const normalized = url.replace(/\.git$/, "");
    const project = await prisma().project.findFirst({
      where: { repoUrl: { contains: normalized.replace(/^https?:\/\//, "") } },
      select: { id: true, defaultBranch: true },
    });
    if (project) return { id: project.id, branch: project.defaultBranch };
  }
  return null;
}