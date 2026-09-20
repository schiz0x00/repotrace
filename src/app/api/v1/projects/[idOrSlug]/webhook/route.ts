import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { env } from "@/lib/env";
import { generateWebhookSecret } from "@/lib/github/webhook";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/webhook — webhook endpoint configuration */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const base = env().BETTER_AUTH_URL.replace(/\/$/, "");
    return json({
      webhook: {
        url: `${base}/api/v1/webhooks/github`,
        secret: generateWebhookSecret(project.id),
        events: ["push"],
        contentType: "application/json",
      },
    });
  })(request, {});
}