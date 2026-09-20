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

/**
 * POST /api/v1/webhooks/github — webhook-driven incremental indexing.
 *
 * Flow: signature validation → project resolution → dedupe by delivery id →
 * enqueue incremental index job (worker re-indexes only changed content).
 */
export async function POST(request: Request) {
  return route(async (req) => {
    const rawBody = Buffer.from(await req.arrayBuffer());
    const headers = req.headers;
    const deliveryId = headers.get("x-github-delivery");
    const signature = headers.get("x-hub-signature-256");
    const eventName = headers.get("x-github-event") ?? "push";

    // Dedupe by delivery id: GitHub retries webhooks; process each once.
    if (deliveryId) {
      const seen = await prisma().webhookDelivery.findUnique({
        where: { provider_deliveryId: { provider: "github", deliveryId } },
      });
      if (seen) return json({ status: "duplicate" });
    }

    if (eventName !== "push") {
      await recordDelivery(deliveryId, null, eventName, "ignored");
      return json({ status: "ignored", reason: `event ${eventName} not handled` });
    }

    let event: GithubPushEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as GithubPushEvent;
    } catch {
      await recordDelivery(deliveryId, null, eventName, "failed", "invalid JSON payload");
      return json({ status: "failed" }, 400);
    }

    const project = await projectForPushEvent(event);
    if (!project) {
      await recordDelivery(deliveryId, null, eventName, "failed", "no matching project");
      return json({ status: "ignored", reason: "no matching project" }, 404);
    }

    // Validate signature against the project's effective secret.
    const secret = webhookSecretFor(project.id);
    if (secret && !verifyWebhookSignature(secret, rawBody, signature)) {
      await recordDelivery(deliveryId, project.id, eventName, "failed", "invalid signature");
      return json({ status: "failed", reason: "invalid signature" }, 401);
    }

    // Only index pushes to the project's default branch.
    const branch = event.ref.replace(/^refs\/heads\//, "");
    if (branch && branch !== project.branch) {
      await recordDelivery(deliveryId, project.id, eventName, "ignored", `branch ${branch} not tracked`);
      return json({ status: "ignored", reason: "branch not tracked" });
    }
    if (!event.after || /^0+$/.test(event.after)) {
      await recordDelivery(deliveryId, project.id, eventName, "ignored", "branch deletion");
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