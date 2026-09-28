import { badRequest, errorBody, notFound, statusOf } from "@/lib/errors";

export type RouteHandler = (
  request: Request,
  params: Record<string, string | undefined>,
) => Promise<Response>;

/**
 * Wraps a route handler with consistent error serialization and logging.
 * Internal errors are logged with their message but the client receives a
 * generic response (no internals leak).
 */
export function route(handler: RouteHandler): RouteHandler {
  return async (request: Request, params: Record<string, string | undefined>) => {
    try {
      return await handler(request, params);
    } catch (err) {
      const status = statusOf(err);
      if (status >= 500) {
        console.error(`[route:error] ${request.method} ${request.url} -> ${(err as Error).message}`);
      }
      return Response.json(errorBody(err), { status });
    }
  };
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Parses and validates a JSON body; throws a 400 AppError on malformed input. */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    // Must be an AppError: a plain Error carrying a `.status` property is
    // ignored by statusOf() and would surface as a 500.
    throw badRequest("invalid_json", "Request body must be valid JSON");
  }
}

export function getParam(
  params: Record<string, string | undefined>,
  name: string,
): string {
  const value = params[name];
  if (!value) throw notFound("missing_route_param", `Missing route parameter: ${name}`);
  return value;
}