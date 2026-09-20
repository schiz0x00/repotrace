import { z } from "zod";

/**
 * All infrastructure configuration flows through environment variables.
 * Values are validated once at process start.
 */

const boolFromString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1),

  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  QDRANT_URL: z.string().min(1).default("http://localhost:6333"),
  QDRANT_API_KEY: z.string().default(""),

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  USE_SECURE_COOKIES: boolFromString,

  // Embedding provider (OpenAI-compatible). Per-project overrides exist in the
  // project table; these values are the system-wide defaults.
  EMBEDDING_PROVIDER: z.string().default("openai-compatible"),
  EMBEDDING_API_URL: z.string().default(""),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_MODEL: z.string().default(""),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(512).default(32),
  EMBEDDING_VERSION: z.coerce.number().int().min(1).default(1),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  // GitHub webhook signature verification
  GITHUB_WEBHOOK_SECRET: z.string().default(""),

  // Repository workspaces
  WORKSPACE_DIR: z.string().min(1).default("data/workspaces"),
  WORKSPACE_RETENTION_DAYS: z.coerce.number().int().min(0).default(7),

  // 32-byte base64 key used to encrypt repository credentials at rest
  REPO_CREDENTIALS_KEY: z.string().min(1).default(""),

  // Outbound email for password reset (SMTP). When unset, reset emails are
  // logged to the console (development only).
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default("repotrace@localhost"),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOB_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(5000),

  MAX_FILE_SIZE_BYTES: z.coerce.number().int().min(1).default(1_000_000),
});

const parsed = EnvSchema.safeParse(process.env);

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validated environment. Throws a descriptive error at startup if invalid. */
export function env(): Env {
  if (cached) return cached;
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when running under the test suite. */
export function isTest(): boolean {
  return process.env.NODE_ENV === "test";
}