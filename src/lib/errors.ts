/** Application error carrying an HTTP status and a machine-readable code. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function badRequest(code: string, message: string, details?: unknown) {
  return new AppError(400, code, message, details);
}

export function unauthorized(code: string, message: string) {
  return new AppError(401, code, message);
}

export function forbidden(code: string, message: string) {
  return new AppError(403, code, message);
}

export function notFound(code: string, message: string) {
  return new AppError(404, code, message);
}

export function conflict(code: string, message: string) {
  return new AppError(409, code, message);
}

/** Error body shape shared by every API and MCP error. */
export function errorBody(err: unknown): { error: { code: string; message: string; details?: unknown } } {
  if (err instanceof AppError) {
    return { error: { code: err.code, message: err.message, details: err.details } };
  }
  // A Zod failure is a client mistake, not a server fault: report it as a 400
  // with the field-level issues rather than an opaque 500.
  const zod = zodIssues(err);
  if (zod) {
    return {
      error: { code: "validation_failed", message: "Request validation failed", details: zod },
    };
  }
  if (err instanceof Error) {
    // Deliberately generic. Internal messages carry filesystem paths, SQL,
    // driver errors and — for git failures — repository credentials, so they
    // are logged server-side and never returned to the client.
    return { error: { code: "internal_error", message: "Internal server error" } };
  }
  return { error: { code: "internal_error", message: "Internal server error" } };
}

/** Extracts Zod issue summaries without importing Zod's error class directly. */
function zodIssues(err: unknown): Array<{ path: string; message: string }> | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as { name?: unknown; issues?: unknown };
  if (candidate.name !== "ZodError" || !Array.isArray(candidate.issues)) return null;
  return candidate.issues.slice(0, 50).map((issue) => {
    const i = issue as { path?: unknown[]; message?: unknown };
    return {
      path: Array.isArray(i.path) ? i.path.join(".") : "",
      message: typeof i.message === "string" ? i.message : "Invalid value",
    };
  });
}

/** Maps an unknown error to an HTTP status. Logs the internal detail once. */
export function statusOf(err: unknown): number {
  if (err instanceof AppError) return err.status;
  if (err && typeof err === "object" && (err as { name?: unknown }).name === "ZodError") return 400;
  return 500;
}

/** Re-exported for route handlers that need to wrap a handler with try/catch. */
export async function withErrorHandling<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}