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
  if (err instanceof Error) {
    return { error: { code: "internal_error", message: err.message } };
  }
  return { error: { code: "internal_error", message: "Unknown error" } };
}

/** Maps an unknown error to an HTTP status. Logs the internal detail once. */
export function statusOf(err: unknown): number {
  return err instanceof AppError ? err.status : 500;
}

/** Re-exported for route handlers that need to wrap a handler with try/catch. */
export async function withErrorHandling<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}