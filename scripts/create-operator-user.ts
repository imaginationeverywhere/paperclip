import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve the same installed dependencies as the server/database packages.
// This private script deliberately adds no root dependency or workflow step.
const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
const dbRequire = createRequire(new URL("../packages/db/package.json", import.meta.url));

export type OperatorQuery = <T extends Record<string, unknown> = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export interface OperatorDatabase {
  begin<T>(callback: (transaction: OperatorQuery) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export interface OperatorDependencies {
  connect(url: string): OperatorDatabase;
  hashPassword(password: string): Promise<string>;
  generatePassword(): string;
  generateId(): string;
  now(): Date;
}

class OperatorInputError extends Error {}
class OperatorDuplicateError extends Error {}

export function parseOperatorArguments(args: string[]): { email: string; name: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--email" && flag !== "--name") || values.has(flag)
      || !value?.trim() || value.startsWith("--")) {
      throw new OperatorInputError("Usage: create-operator-user.ts --email <email> --name <name>");
    }
    values.set(flag, value.trim());
  }
  const email = values.get("--email")?.toLowerCase();
  const name = values.get("--name");
  const { z } = serverRequire("zod");
  if (!email || !name || !z.string().email().safeParse(email).success) {
    throw new OperatorInputError("A valid --email and non-empty --name are required.");
  }
  return { email, name };
}

export async function loadOperatorDependencies(): Promise<OperatorDependencies> {
  const crypto = await import(pathToFileURL(serverRequire.resolve("better-auth/crypto")).href);
  const postgres = dbRequire("postgres");
  return {
    connect: (url) => postgres(url, { max: 1, onnotice: () => {} }),
    hashPassword: crypto.hashPassword,
    generatePassword: () => randomBytes(32).toString("base64url"),
    generateId: randomUUID,
    now: () => new Date(),
  };
}

export async function runCreateOperatorUser(
  args: string[],
  env: { DATABASE_URL?: string },
  io: { stdout(text: string): void; stderr(text: string): void },
  dependencies?: OperatorDependencies,
): Promise<number> {
  let db: OperatorDatabase | undefined;
  let committed = false;
  try {
    const { email, name } = parseOperatorArguments(args);
    if (!env.DATABASE_URL?.trim()) {
      throw new OperatorInputError("DATABASE_URL must be supplied through the environment.");
    }
    const deps = dependencies ?? await loadOperatorDependencies();
    db = deps.connect(env.DATABASE_URL);
    const password = deps.generatePassword();
    // Better Auth's own implementation, not a replacement hash format.
    const passwordHash = await deps.hashPassword(password);
    await db.begin(async (tx) => {
      // The current user schema has no unique email constraint. Serialize inserts
      // before checking normalized email, including concurrent operator runs.
      await tx`LOCK TABLE "user" IN SHARE ROW EXCLUSIVE MODE`;
      const existing = await tx`SELECT id FROM "user" WHERE lower(btrim(email)) = ${email} LIMIT 1`;
      if (existing.length > 0) throw new OperatorDuplicateError();
      const userId = deps.generateId();
      const accountId = deps.generateId();
      const now = deps.now();
      await tx`INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at)
        VALUES (${userId}, ${name}, ${email}, ${false}, ${null}, ${now}, ${now})`;
      await tx`INSERT INTO "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
        VALUES (${accountId}, ${userId}, ${"credential"}, ${userId}, ${passwordHash}, ${now}, ${now})`;
    });
    committed = true;
    // The only plaintext credential output; begin resolves after COMMIT.
    io.stdout(`${JSON.stringify({ email, name, password })}\n`);
    return 0;
  } catch (error) {
    // Never forward database/hash errors: they can contain parameters or URLs.
    const message = committed
      ? "Account committed, but credential output failed. Do not retry account creation."
      : error instanceof OperatorInputError
        ? error.message
        : error instanceof OperatorDuplicateError
          ? "An account with that normalized email already exists; no changes committed."
          : "Operator account creation failed; no credentials emitted.";
    io.stderr(`${message}\n`);
    return 1;
  } finally {
    // A disconnect error must not expose driver details or discard credentials
    // for an account whose transaction has already committed.
    await db?.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCreateOperatorUser(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  }).then((code) => { process.exitCode = code; });
}
