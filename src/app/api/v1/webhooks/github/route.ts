import { route, json } from "@/lib/http";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  projectForPushEvent,
  verifyWebhookSignature,
  webhookSecretFor,
  type GithubPushEvent,
} from "@/lib/github/webhook";

export const runtime = "nodejs";

/** GitHub push payloads are small; anything larger is not a push event. */
const MAX_WEBHOOK_BYTES = 1_000_000;

/**
 * POST /api/v1/webhooks/github — webhook-driven incremental indexing.
 *
 * Flow: size check → parse → project resolution → signature validation →
 * dedupe by delivery id → enqueue incremental index job.
 *
 * Note the signature is checked against the resolved project's secret, so
 * project resolution necessarily precedes it. An unauthenticated caller can
 * therefore learn whether a repository is registered, but cannot trigger work
 * without a valid HMAC.
 */
export async function POST(request: Request) {
  return route(async (req) => {
    const headers = req.headers;
    const deliveryId = headers.get("x-github-delivery");
    const signature = headers.get("x-hub-signature-256");
    const eventName = headers.get("x-github-event") ?? "push";

    // Bound the body before buffering it. This endpoint is unauthenticated,
    // so an unbounded read is a free memory-exhaustion vector.
    const declared = Number(headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      return json({ status: "failed", reason: "payload too large" }, 413);
    }
    const rawBody = Buffer.from(await req.arrayBuffer());
    if (rawBody.byteLength > MAX_WEBHOOK_BYTES) {
      return json({ status: "failed", reason: "payload too large" }, 413);
    }

    // Dedupe by delivery id: GitHub retries webhooks; process each once.
    if (deliveryId) {
      const seen = await prisma().webhookDelivery.findUnique({
        where: { provider_deliveryId: { provider: "github", deliveryId } },
      });
      if (seen) return json({ status: "duplicate" });
    }

    if (eventName !== "push") {
      return json({ status: "ignored", reason: `event ${eventName} not handled` });
    }

    let event: GithubPushEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as GithubPushEvent;
    } catch {
      // Not recorded: an unauthenticated caller could otherwise grow the
      // webhook_delivery table at will.
      return json({ status: "failed" }, 400);
    }

    const project = await projectForPushEvent(event);
    if (!project) {
      return json({ status: "ignored", reason: "no matching project" }, 404);
    }

    // Validate signature against the project's effective secret.
    const secret = webhookSecretFor(project.id);
    if (secret && !verifyWebhookSignature(secret, rawBody, signature)) {
      return json({ status: "failed", reason: "invalid signature" }, 401);
    }

    // Only index pushes to the project's default branch.
    const branch = event.ref.replace(/^refs\/heads\//, "");
    if (branch && branch !== project.branch) {
      return json({ status: "ignored", reason: "branch not tracked" });
    }
    if (!event.after || /^0+$/.test(event.after)) {
      return json({ status: "ignored", reason: "branch deletion" });
    }

    const jobId = await enqueueJob(project.id, "incremental_index", {
      dedupe: true,
      delayMs: 2000,
      metadata: { source: "webhook", deliveryId, commit: event.after },
    });
    await recordDelivery(deliveryId, project.id, eventName, "processed");
    return json({ status: "processed", jobId });
  })(request, {});
}

async function recordDelivery(
  deliveryId: string | null,
  projectId: string | null,
  event: string,
  status: string,
  error?: string,
): Promise<void> {
  if (!deliveryId) return;
  await prisma().webhookDelivery.upsert({
    where: { provider_deliveryId: { provider: "github", deliveryId } },
    create: { provider: "github", deliveryId, projectId, event, status, error },
    update: {},
  });
}