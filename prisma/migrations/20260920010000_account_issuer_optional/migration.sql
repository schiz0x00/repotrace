-- Better Auth 1.7 no longer writes an issuer column for credential accounts.
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
DROP INDEX IF EXISTS "account_issuer_accountId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "account_providerId_accountId_key" ON "account"("providerId", "accountId");
