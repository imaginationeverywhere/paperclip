import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Db } from "@paperclipai/db";
import type { Config } from "../config.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("Paperclip production registration policy", () => {
  it("rejects public email/password sign-up using the deployed disable-sign-up flag", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "paperclip-test-only-auth-secret-at-least-32-characters");
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://paperclip.example");
    const config = JSON.parse(readFileSync(new URL("../../../wrangler.paperclip.jsonc", import.meta.url), "utf8"));
    const writes = vi.fn(() => { throw new Error("Registration must not write an account"); });
    const db = { insert: writes, update: writes, delete: writes } as unknown as Db;
    const auth = createBetterAuthInstance(db, {
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example",
      authDisableSignUp: config.vars.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true",
      allowedHostnames: [],
    } as Config);
    const response = await auth.handler(new Request("https://paperclip.example/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://paperclip.example" },
      body: JSON.stringify({ name: "Test account", email: "test@example.com", password: "test-only-password" }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe("Email and password sign up is not enabled");
    expect(writes).not.toHaveBeenCalled();
  });
});
