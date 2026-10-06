import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issueLabels, issues, labels } from "@paperclipai/db";
import { createIssueSchema, updateIssueSchema } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("source_env validation", () => {
  it.each(["production", "staging", "develop"])("accepts %s only at creation", (source_env) => {
    expect(createIssueSchema.parse({ title: "Task", source_env }).source_env).toBe(source_env);
    expect(updateIssueSchema.parse({ title: "Updated", source_env })).not.toHaveProperty("source_env");
  });

  it.each(["prod", "development", "", 1])("rejects an invalid source environment (%s)", (source_env) => {
    expect(createIssueSchema.safeParse({ title: "Task", source_env }).success).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`source_env database tests unavailable: ${support.reason}`);

(support.supported ? describe : describe.skip)("issue source_env persistence and API", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-source-env-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Test company", issuePrefix: `T${id.slice(0, 6).toUpperCase()}` });
    return id;
  }

  function app(agentCompanyId?: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = agentCompanyId
        ? { type: "agent", companyId: agentCompanyId, agentId: randomUUID() }
        : { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it.each(["production", "staging", "develop"])("persists %s and returns it through create, get and list", async (source_env) => {
    const companyId = await company();
    const api = app();
    const created = await request(api).post(`/api/companies/${companyId}/issues`).send({ title: "Task", source_env });
    expect(created.status).toBe(201);
    expect(created.body.source_env).toBe(source_env);
    const fetched = await request(api).get(`/api/issues/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.source_env).toBe(source_env);
    const listed = await request(api).get(`/api/companies/${companyId}/issues`);
    expect(listed.status).toBe(200);
    expect(listed.body[0].source_env).toBe(source_env);
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, created.body.id));
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ action: "issue.created", details: expect.objectContaining({ source_env }) })]));
  });

  it("keeps omitted/null attribution and ordinary labels compatible", async () => {
    const companyId = await company();
    const label = await svc.createLabel(companyId, { name: "existing-label", color: "#112233" });
    for (const extra of [{}, { source_env: null }]) {
      const created = await request(app()).post(`/api/companies/${companyId}/issues`)
        .send({ title: "Legacy task", labelIds: [label.id], ...extra });
      expect(created.status).toBe(201);
      expect(created.body.source_env).toBeNull();
      expect(created.body.labelIds).toEqual([label.id]);
    }
  });

  it("rejects invalid values and cross-company agent writes without side effects", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    expect((await request(app()).post(`/api/companies/${companyId}/issues`).send({ title: "Task", source_env: "prod" })).status).toBe(400);
    expect((await request(app(otherCompanyId)).post(`/api/companies/${companyId}/issues`).send({ title: "Task", source_env: "production" })).status).toBe(403);
    expect(await svc.list(companyId)).toEqual([]);
    expect(await svc.listLabels(companyId)).toEqual([]);
  });

  it("rolls back issue creation and counter changes when a foreign label is supplied", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    const foreignLabel = await svc.createLabel(otherCompanyId, { name: "foreign", color: "#112233" });
    await expect(svc.create(companyId, { title: "Invalid", source_env: "production", labelIds: [foreignLabel.id] })).rejects.toThrow();
    expect(await svc.list(companyId)).toEqual([]);
    expect(await svc.listLabels(companyId)).toEqual([]);
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row.issueCounter).toBe(0);
  });

  it("reuses one label for concurrent creates and isolates labels by company", async () => {
    const companyId = await company();
    const otherCompanyId = await company();
    const [first, second, other] = await Promise.all([
      svc.create(companyId, { title: "First", source_env: "production" }),
      svc.create(companyId, { title: "Second", source_env: "production" }),
      svc.create(otherCompanyId, { title: "Other", source_env: "production" }),
    ]);
    expect(first.source_env).toBe("production");
    expect(second.labelIds).toEqual(first.labelIds);
    expect(other.labelIds).not.toEqual(first.labelIds);
    expect(await svc.listLabels(companyId)).toHaveLength(1);
  });

  it("preserves provenance when editing labels and rejects replacement or deletion", async () => {
    const companyId = await company();
    const first = await svc.create(companyId, { title: "Production task", source_env: "production" });
    const second = await svc.create(companyId, { title: "Staging task", source_env: "staging" });
    expect((await svc.update(first.id, { labelIds: [] }))?.source_env).toBe("production");
    await expect(svc.update(first.id, { title: "Must roll back", labelIds: second.labelIds })).rejects.toThrow("only at creation");
    expect((await svc.getById(first.id))?.title).toBe("Production task");
    await expect(svc.deleteLabel(first.labelIds[0])).rejects.toThrow("cannot be deleted");
    await expect(svc.createLabel(companyId, { name: " source_env:develop ", color: "#112233" })).rejects.toThrow("reserved");
    await expect(svc.create(companyId, { title: "Spoofed", labelIds: second.labelIds })).rejects.toThrow("reserved");
    const legacy = await svc.create(companyId, { title: "Legacy" });
    await expect(svc.update(legacy.id, { labelIds: second.labelIds })).rejects.toThrow("only at creation");
    expect((await svc.getById(legacy.id))?.source_env).toBeNull();
    expect(await db.select().from(labels).where(eq(labels.companyId, companyId))).toHaveLength(2);
  });
});
