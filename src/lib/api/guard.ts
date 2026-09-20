import type { Principal } from "@/lib/authn";
import { authenticateRequest } from "@/lib/authn";
import { unauthorized } from "@/lib/errors";
import { requireProjectByIdOrSlug } from "@/lib/projects/service";
import { canAccessProject } from "@/lib/authn";

/**
 * Authenticates an API v1 request and returns the principal (session or API
 * key). Endpoints may be reached by the dashboard (session cookie) or by
 * machine clients (Bearer API key).
 */
export async function requirePrincipal(request: Request): Promise<Principal> {
  const principal = await authenticateRequest(request);
  if (!principal) {
    throw unauthorized(
      "authentication_required",
      "Authenticate with a session cookie or an API key (Authorization: Bearer rt_...)",
    );
  }
  return principal;
}

/** Resolves a project scoped by the caller, enforcing project isolation. */
export async function requireScopedProject(request: Request, idOrSlug: string) {
  const principal = await requirePrincipal(request);
  const project = await requireProjectByIdOrSlug(idOrSlug);
  if (!canAccessProject(principal, project.id)) {
    throw unauthorized("project_forbidden", "This credential cannot access the requested project");
  }
  return { principal, project };
}

export async function requireScopedProjectId(request: Request, idOrSlug: string): Promise<string> {
  const { project } = await requireScopedProject(request, idOrSlug);
  return project.id;
}