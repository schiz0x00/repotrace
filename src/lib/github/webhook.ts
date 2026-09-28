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

/**
 * Reduces a clone URL to a comparable identity: `host/owner/repo`, lowercased,
 * with the scheme, any userinfo, a `.git` suffix and trailing slashes removed.
 *
 * GitHub reports the same repository as `https://github.com/o/r`,
 * `https://github.com/o/r.git` and `git@github.com:o/r.git` depending on which
 * field you read, and an operator may have configured any of them.
 */
export function canonicalRepoUrl(url: string): string {
  let s = url.trim();
  s = s.replace(/\.git$/i, "");
  s = s.replace(/^ssh:\/\/(?:[^@/]+@)?/i, "");
  s = s.replace(/^git@([^:]+):/, "$1/");
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^/@]+@/, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

/** Finds the project a push event belongs to, by repository URL or name. */
export async function projectForPushEvent(event: GithubPushEvent): Promise<{ id: string; branch: string } | null> {
  const urls = [
    event.repository?.html_url,
    event.repository?.clone_url,
    event.repository?.full_name ? `https://github.com/${event.repository.full_name}` : undefined,
    event.repository?.full_name ? `git@github.com:${event.repository.full_name}.git` : undefined,
  ].filter(Boolean) as string[];

  const targets = [...new Set(urls.map(canonicalRepoUrl).filter(Boolean))];
  if (targets.length === 0) return null;

  // The previous fallback matched with `repoUrl: { contains: ... }`, so a push
  // to `acme/foo` matched a project configured as `acme/foobar` and indexed the
  // wrong repository. That query is kept only as a cheap host prefilter — the
  // decision is made below on exact canonical equality.
  const host = targets[0].split("/")[0];
  const candidates = await prisma().project.findMany({
    where: { repoUrl: { contains: host } },
    select: { id: true, defaultBranch: true, repoUrl: true },
  });
  const match = candidates.find((p) => targets.includes(canonicalRepoUrl(p.repoUrl)));
  return match ? { id: match.id, branch: match.defaultBranch } : null;
}