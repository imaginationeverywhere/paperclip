import { describe, expect, it, vi } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import { tsImport } from "tsx/esm/api";
import type {
  OperatorDatabase,
  OperatorDependencies,
  OperatorQuery,
} from "../../../scripts/create-operator-user.js";

// Load the standalone CLI through its runtime loader. Vite's root-project
// transform follows an existing missing droid-local tsconfig reference.
const { loadOperatorDependencies, parseOperatorArguments, runCreateOperatorUser } =
  await tsImport("../../../scripts/create-operator-user.ts", { parentURL: import.meta.url, tsconfig: false }) as typeof import("../../../scripts/create-operator-user.js");

const args = ["--email", " Operator@Example.com ", "--name", " Private Operator "];
const env = { DATABASE_URL: "postgres://unit.invalid/test" };
const testPassword = "unit-test-only-generated-password";
const timestamp = new Date("2026-10-06T00:00:00Z");

function fixture(options: { existingEmail?: string; failAt?: "user" | "account" | "commit" } = {}) {
  const state = {
    users: options.existingEmail ? [["existing", "Existing", options.existingEmail]] as unknown[][] : [] as unknown[][],
    accounts: [] as unknown[][],
    committed: false,
    rolledBack: false,
    queries: [] as string[],
    events: [] as string[],
  };
  const db: OperatorDatabase = {
    begin: vi.fn(async (callback) => {
      const users = [...state.users];
      const accounts = [...state.accounts];
      const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        state.queries.push(query);
        if (query.startsWith("LOCK TABLE")) return [];
        if (query.startsWith("SELECT id")) {
          return users.filter((row) => String(row[2]).trim().toLowerCase() === values[0])
            .map((row) => ({ id: row[0] }));
        }
        if (query.startsWith('INSERT INTO "user"')) {
          if (options.failAt === "user") throw new Error(`driver error ${testPassword} ${env.DATABASE_URL}`);
          users.push(values);
          return [];
        }
        if (query.startsWith('INSERT INTO "account"')) {
          if (options.failAt === "account") throw new Error(`driver error ${testPassword} ${env.DATABASE_URL}`);
          accounts.push(values);
          return [];
        }
        throw new Error("Unexpected query");
      }) as OperatorQuery;
      try {
        const result = await callback(tx);
        if (options.failAt === "commit") throw new Error(`commit error ${testPassword}`);
        state.users = users;
        state.accounts = accounts;
        state.committed = true;
        state.events.push("commit");
        return result;
      } catch (error) {
        state.rolledBack = true;
        throw error;
      }
    }),
    end: vi.fn(async () => {}),
  };
  const deps: OperatorDependencies = {
    connect: vi.fn(() => db),
    hashPassword: vi.fn(async () => "test-only-password-hash"),
    generatePassword: vi.fn(() => testPassword),
    generateId: vi.fn().mockReturnValueOnce("user-test").mockReturnValueOnce("account-test"),
    now: () => timestamp,
  };
  const io = {
    stdout: vi.fn((_text: string) => {
      expect(state.committed).toBe(true);
      state.events.push("stdout");
    }),
    stderr: vi.fn((_text: string) => {}),
  };
  return { state, db, deps, io };
}

describe("private operator user CLI", () => {
  it.each([
    [], ["--email", "test@example.com"], ["--name", "Operator"],
    ["--email"], ["--email", "--name", "Operator"],
    ["--email", "invalid", "--name", "Operator"],
    ["--email", "test@example.com", "--name", " "],
    ["--email", "test@example.com", "--name", "Operator", "--unknown", "value"],
    ["--email", "test@example.com", "--name", "Operator", "--email", "second@example.com"],
  ])("rejects invalid arguments before accessing the database: %j", async (...invalidArgs) => {
    const f = fixture();
    expect(await runCreateOperatorUser(invalidArgs, env, f.io, f.deps)).toBe(1);
    expect(f.deps.connect).not.toHaveBeenCalled();
    expect(f.deps.generatePassword).not.toHaveBeenCalled();
    expect(f.io.stdout).not.toHaveBeenCalled();
  });

  it("normalizes email and trims the operator name", () => {
    expect(parseOperatorArguments(args)).toEqual({ email: "operator@example.com", name: "Private Operator" });
  });

  it.each([undefined, "", " "])("requires an environment DATABASE_URL before generating credentials: %j", async (url) => {
    const f = fixture();
    expect(await runCreateOperatorUser(args, { DATABASE_URL: url }, f.io, f.deps)).toBe(1);
    expect(f.deps.connect).not.toHaveBeenCalled();
    expect(f.deps.generatePassword).not.toHaveBeenCalled();
    expect(f.io.stdout).not.toHaveBeenCalled();
    expect(f.io.stderr).toHaveBeenCalledWith("DATABASE_URL must be supplied through the environment.\n");
  });

  it("refuses an existing normalized email before either insert and locks before checking", async () => {
    const f = fixture({ existingEmail: " OPERATOR@EXAMPLE.COM " });
    expect(await runCreateOperatorUser(args, env, f.io, f.deps)).toBe(1);
    expect(f.state.users).toHaveLength(1);
    expect(f.state.accounts).toEqual([]);
    expect(f.state.queries).toEqual([
      'LOCK TABLE "user" IN SHARE ROW EXCLUSIVE MODE',
      'SELECT id FROM "user" WHERE lower(btrim(email)) = ? LIMIT 1',
    ]);
    expect(f.state.rolledBack).toBe(true);
    expect(f.io.stdout).not.toHaveBeenCalled();
    expect(f.io.stderr).toHaveBeenCalledWith("An account with that normalized email already exists; no changes committed.\n");
  });

  it("inserts exactly the Better Auth user and credential fields in one transaction before stdout", async () => {
    const f = fixture();
    expect(await runCreateOperatorUser(args, env, f.io, f.deps)).toBe(0);
    expect(f.db.begin).toHaveBeenCalledTimes(1);
    expect(f.state.users).toEqual([["user-test", "Private Operator", "operator@example.com", false, null, timestamp, timestamp]]);
    expect(f.state.accounts).toEqual([["account-test", "user-test", "credential", "user-test", "test-only-password-hash", timestamp, timestamp]]);
    expect(f.state.queries[2]).toContain('(id, name, email, email_verified, image, created_at, updated_at)');
    expect(f.state.queries[3]).toContain('(id, account_id, provider_id, user_id, password, created_at, updated_at)');
    expect(f.deps.hashPassword).toHaveBeenCalledWith(testPassword);
    expect(f.io.stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.io.stdout.mock.calls[0][0])).toEqual({ email: "operator@example.com", name: "Private Operator", password: testPassword });
    expect(f.state.events).toEqual(["commit", "stdout"]);
    expect(f.io.stderr).not.toHaveBeenCalled();
    expect(f.db.end).toHaveBeenCalledTimes(1);
  });

  it.each(["user", "account", "commit"] as const)("rolls back both records on %s failure without emitting credentials or driver details", async (failAt) => {
    const f = fixture({ failAt });
    expect(await runCreateOperatorUser(args, env, f.io, f.deps)).toBe(1);
    expect(f.state.users).toEqual([]);
    expect(f.state.accounts).toEqual([]);
    expect(f.state.rolledBack).toBe(true);
    expect(f.state.committed).toBe(false);
    expect(f.io.stdout).not.toHaveBeenCalled();
    expect(f.io.stderr).toHaveBeenCalledWith("Operator account creation failed; no credentials emitted.\n");
    expect(f.db.end).toHaveBeenCalledTimes(1);
  });

  it("does not begin a transaction if Better Auth hashing fails and suppresses the underlying error", async () => {
    const f = fixture();
    f.deps.hashPassword = vi.fn(async () => { throw new Error(testPassword); });
    expect(await runCreateOperatorUser(args, env, f.io, f.deps)).toBe(1);
    expect(f.db.begin).not.toHaveBeenCalled();
    expect(f.io.stdout).not.toHaveBeenCalled();
    expect(f.io.stderr).toHaveBeenCalledWith("Operator account creation failed; no credentials emitted.\n");
    expect(f.db.end).toHaveBeenCalledTimes(1);
  });

  it("uses the installed Better Auth hash format for a fresh random initial password without a real connection", async () => {
    const f = fixture();
    const defaults = await loadOperatorDependencies();
    const deps = { ...defaults, connect: f.deps.connect };
    expect(await runCreateOperatorUser(args, env, f.io, deps)).toBe(0);
    const credential = JSON.parse(f.io.stdout.mock.calls[0][0]);
    expect(credential.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword({ password: credential.password, hash: String(f.state.accounts[0][4]) })).toBe(true);
    expect(f.state.accounts[0][4]).not.toBe(credential.password);
    expect(f.io.stderr).not.toHaveBeenCalled();
  });

  it("reports a failed credential write after commit without exposing credentials or falsely claiming rollback", async () => {
    const f = fixture();
    f.io.stdout = vi.fn(() => { throw new Error(testPassword); });
    expect(await runCreateOperatorUser(args, env, f.io, f.deps)).toBe(1);
    expect(f.state.committed).toBe(true);
    expect(f.state.rolledBack).toBe(false);
    expect(f.io.stderr).toHaveBeenCalledWith("Account committed, but credential output failed. Do not retry account creation.\n");
  });
});
