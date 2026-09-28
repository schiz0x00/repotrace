import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

declare global {
  var __repotracePrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env().DATABASE_URL,
  });
  return new PrismaClient({ adapter });
}

/**
 * Singleton PrismaClient, cached on globalThis in every environment.
 *
 * The client owns a `pg` connection pool, so constructing one per call leaks a
 * pool per query and exhausts Postgres connections under load. Caching on
 * globalThis also survives Next.js dev hot reloads, which is why the same
 * pattern is used in production rather than only in development.
 */
export function prisma(): PrismaClient {
  if (!globalThis.__repotracePrisma) {
    globalThis.__repotracePrisma = createClient();
  }
  return globalThis.__repotracePrisma;
}

/** Closes the shared pool. Called on worker shutdown so the process can exit. */
export async function disconnectPrisma(): Promise<void> {
  const client = globalThis.__repotracePrisma;
  if (!client) return;
  globalThis.__repotracePrisma = undefined;
  await client.$disconnect();
}