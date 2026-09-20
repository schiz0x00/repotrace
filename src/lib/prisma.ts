import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __repotracePrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });
  return new PrismaClient({ adapter });
}

/**
 * Singleton PrismaClient. In Next.js dev the client is cached on globalThis so
 * hot reloads do not exhaust database connections.
 */
export function prisma(): PrismaClient {
  if (process.env.NODE_ENV === "production") return createClient();
  if (!globalThis.__repotracePrisma) {
    globalThis.__repotracePrisma = createClient();
  }
  return globalThis.__repotracePrisma;
}