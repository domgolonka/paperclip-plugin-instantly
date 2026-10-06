import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ENDPOINTS } from "../src/endpoints.js";
import manifest from "../src/manifest.js";
import plugin, { buildUrl, findEndpoint, isDestructive } from "../src/worker.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ref = { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222" };
// The SDK harness resolves any secret ref to `resolved:${ref}`.
const RESOLVED = `resolved:${ref}`;

async function setup(extra: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config: { apiKey: ref, webhookSecret: ref, ...extra } });
  harness.seed({ companies: [{ id: COMPANY, name: "Acme" } as never] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("endpoint catalog", () => {
  it("covers the whole API with unique ids and callable paths", () => {
    expect(ENDPOINTS.length).toBeGreaterThanOrEqual(255);
    expect(new Set(ENDPOINTS.map((e) => e.id)).size).toBe(ENDPOINTS.length);
    for (const e of ENDPOINTS) {
      for (const [, name] of e.path.matchAll(/\{([^}]+)\}/g)) {
        expect(e.params?.some((p) => p.name === name && p.in === "path"), `${e.id} declares {${name}}`).toBe(true);
      }
    }
  });

  it("buildUrl fills path params, encodes them and joins list queries", () => {
    expect(buildUrl(findEndpoint("getAccount"), { email: "a b@x.com" })).toBe("https://api.instantly.ai/api/v2/accounts/a%20b%40x.com");
    expect(buildUrl(findEndpoint("listcampaign"), { limit: 5, tag_ids: ["a", "b"] })).toBe(
      "https://api.instantly.ai/api/v2/campaigns?limit=5&tag_ids=a%2Cb",
    );
    expect(() => buildUrl(findEndpoint("getAccount"), {})).toThrow("requires path parameter email");
    expect(() => buildUrl(findEndpoint("listCampaign"), { nope: 1 })).toThrow("has no parameter nope");
    expect(() => findEndpoint("dropTables")).toThrow("Unknown Instantly operation");
  });

  it("flags destructive operations", () => {
    for (const id of ["deleteCampaign", "bulkDeleteAgentItems", "changeWorkspaceOwner", "createDFYEmailAccountOrder"]) {
      expect(isDestructive(findEndpoint(id)), id).toBe(true);
    }
    for (const id of ["listCampaign", "replyToEmail", "bulkAddLeads", "activateCampaign"]) {
      expect(isDestructive(findEndpoint(id)), id).toBe(false);
    }
  });
});

describe("tools", () => {
  it("find-endpoints lists tags, then filters by tag and query", async () => {
    const harness = await setup();
    const all = JSON.parse((await harness.executeTool<{ content: string }>("find-endpoints", {}, { companyId: COMPANY })).content);
    expect(all.total).toBe(ENDPOINTS.length);
    expect(all.tags.Campaign).toBeGreaterThan(5);

    const hits = JSON.parse(
      (await harness.executeTool<{ content: string }>("find-endpoints", { tag: "email", query: "reply" }, { companyId: COMPANY })).content,
    );
    expect(hits).toEqual(["replyToEmail: POST /api/v2/emails/reply — Reply to an email"]);
  });

  it("call-endpoint sends the bearer key, query and body", async () => {
    const fetchMock = mockFetch({ id: "e1" });
    const harness = await setup();

    const result = await harness.executeTool<{ content: string }>(
      "call-endpoint",
      { id: "replyToEmail", body: { reply_to_uuid: "u1", eaccount: "me@x.com", subject: "Re", body: { text: "hi" } } },
      { companyId: COMPANY },
    );

    expect(JSON.parse(result.content)).toEqual({ id: "e1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.instantly.ai/api/v2/emails/reply");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${RESOLVED}`);
    expect(JSON.parse(String(init!.body)).reply_to_uuid).toBe("u1");
  });

  it("blocks destructive calls unless allowed, and returns API errors", async () => {
    const fetchMock = mockFetch({ message: "Campaign not found" }, 404);
    const blocked = await setup();
    const denied = await blocked.executeTool<{ error: string }>("call-endpoint", { id: "deleteCampaign", params: { id: "c1" } }, { companyId: COMPANY });
    expect(denied.error).toMatch(/destructive and blocked/);
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = await setup({ allowDestructive: true });
    const result = await allowed.executeTool<{ error: string }>("call-endpoint", { id: "deleteCampaign", params: { id: "c1" } }, { companyId: COMPANY });
    expect(result.error).toBe("Instantly API 404: Campaign not found");
    expect(fetchMock.mock.calls[0][1]!.method).toBe("DELETE");
  });
});

describe("inbound webhook", () => {
  const event = {
    event_type: "reply_received",
    timestamp: "2026-10-05T12:00:00.000Z",
    campaign_id: "c1",
    campaign_name: "Q4 outbound",
    lead_email: "lead@example.com",
    email_account: "me@acme.com",
    email_id: "e1",
    reply_text: "Sounds good,\nlet's talk",
  };
  const input = (body: unknown, secret = RESOLVED) => ({
    endpointKey: "events",
    headers: { "x-paperclip-company-id": COMPANY, "x-paperclip-webhook-secret": secret },
    rawBody: JSON.stringify(body),
    parsedBody: body,
    requestId: "req",
  });

  it("opens one issue per delivered event", async () => {
    const harness = await setup({ issueAssigneeAgentId: "agent-1" });
    const create = vi.spyOn(harness.ctx.issues, "create");

    await plugin.definition.onWebhook!(input(event));
    await plugin.definition.onWebhook!(input(event)); // Instantly retry

    expect(create).toHaveBeenCalledTimes(1);
    const issue = create.mock.calls[0][0];
    expect(issue).toMatchObject({ companyId: COMPANY, title: "Instantly reply received: lead@example.com", assigneeAgentId: "agent-1" });
    expect(issue.description).toContain("> let's talk");
    expect(issue.description).toContain('"reply_to_uuid": "e1"');
  });

  it("ignores events that are not configured and rejects a wrong secret", async () => {
    const harness = await setup();
    const create = vi.spyOn(harness.ctx.issues, "create");
    await plugin.definition.onWebhook!(input({ ...event, event_type: "email_opened" }));
    expect(create).not.toHaveBeenCalled();

    await expect(plugin.definition.onWebhook!(input(event, "nope"))).rejects.toThrow("Invalid x-paperclip-webhook-secret");
  });
});
