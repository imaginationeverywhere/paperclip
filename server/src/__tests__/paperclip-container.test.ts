import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../../../wrangler.paperclip.jsonc", import.meta.url), "utf8"));

const mocks = vi.hoisted(() => ({ getContainer: vi.fn(), fetch: vi.fn() }));
vi.mock("@cloudflare/containers", () => ({
  Container: class {
    env: unknown;
    envVars = {};
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
  getContainer: mocks.getContainer,
}));
import worker, { PaperclipContainer } from "../../../cloudflare/paperclip/worker.js";

describe("Paperclip Container", () => {
  it("forwards every path and method to the same production instance without changing the request", async () => {
    const namespace = {};
    const env = { PAPERCLIP: namespace } as any;
    mocks.getContainer.mockReturnValue({ fetch: mocks.fetch });
    for (const [method, path] of [["GET", "/"], ["POST", "/api/companies/c/issues"], ["PATCH", "/api/issues/i"]]) {
      const request = new Request(`https://paperclip.example${path}`, { method, headers: { Authorization: "Bearer test-only" } });
      const response = new Response("upstream", { status: 202 });
      mocks.fetch.mockResolvedValue(response);
      expect(await worker.fetch(request, env)).toBe(response);
      expect(mocks.getContainer).toHaveBeenLastCalledWith(namespace, "quiknation-production");
      expect(mocks.fetch).toHaveBeenLastCalledWith(request);
    }
  });

  it("passes stable persistence and explicit public auth configuration to the container", () => {
    const env = {
      DATABASE_URL: "test-only-db", BETTER_AUTH_SECRET: "test-only-auth",
      PAPERCLIP_AGENT_JWT_SECRET: "test-only-jwt", PAPERCLIP_SECRETS_MASTER_KEY: "test-only-master",
      AWS_ACCESS_KEY_ID: "test-only-r2-id", AWS_SECRET_ACCESS_KEY: "test-only-r2-secret",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated", PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      PAPERCLIP_AUTH_BASE_URL_MODE: "explicit", PAPERCLIP_AUTH_PUBLIC_BASE_URL: "https://paperclip.example",
      PAPERCLIP_AUTH_DISABLE_SIGN_UP: config.vars.PAPERCLIP_AUTH_DISABLE_SIGN_UP,
      PAPERCLIP_SECRETS_STRICT_MODE: "true", PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_STORAGE_PROVIDER: "s3", PAPERCLIP_STORAGE_S3_BUCKET: "quiknation-paperclip",
      PAPERCLIP_STORAGE_S3_REGION: "auto", PAPERCLIP_STORAGE_S3_ENDPOINT: "https://test-only.r2.cloudflarestorage.com",
      PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "true",
    };
    const container = new PaperclipContainer({} as any, env as any);
    expect(container.envVars).toEqual(env);
    expect(container.envVars.PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBe("true");
    expect(container.defaultPort).toBe(3100);
    expect(container.sleepAfter).toBe("30m");
    expect(container.enableInternet).toBe(true);
    expect(container.envVars).not.toHaveProperty("AWS_SESSION_TOKEN");
  });

  it("uses only bucket-scoped S3 storage without an unused native R2 binding", () => {
    expect(config).not.toHaveProperty("r2_buckets");
    expect(config.vars.PAPERCLIP_STORAGE_PROVIDER).toBe("s3");
    expect(config.vars.PAPERCLIP_STORAGE_S3_BUCKET).toBe("quiknation-paperclip");
  });
});
