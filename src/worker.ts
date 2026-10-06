import { createHash, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { ENDPOINTS, type Endpoint } from "./endpoints.js";
import manifest from "./manifest.js";

interface InstantlyConfig {
  apiKey?: unknown;
  allowDestructive?: boolean;
  webhookSecret?: unknown;
  issueEvents?: string[];
  issueProjectId?: string;
  issueAssigneeAgentId?: string;
}

/** Instantly webhook payload; lead fields from the workspace may appear as extra keys. */
type InstantlyEvent = Record<string, unknown> & {
  event_type?: string;
  timestamp?: string;
  campaign_id?: string;
  campaign_name?: string;
  lead_email?: string;
  email_account?: string;
  email_id?: string;
  unibox_url?: string;
  reply_subject?: string;
  reply_text?: string;
  reply_text_snippet?: string;
};

const BASE_URL = "https://api.instantly.ai";
// ponytail: hard truncation keeps agent context small; agents page with starting_after/limit
const MAX_TOOL_CHARS = 50_000;
const TIMEOUT_MS = 30_000;
const DEFAULT_ISSUE_EVENTS = ["reply_received", "lead_interested", "lead_meeting_booked"];
/** Irreversible, account-level or paid operations that are not DELETEs or named *delete*. */
const DESTRUCTIVE_IDS = new Set([
  "scheduleCurrentWorkspaceRemoval",
  "changeWorkspaceOwner",
  "createAPIKey",
  "moveAccounts",
  "mergeLeads",
  "createDFYEmailAccountOrder",
  "cancelDFYEmailAccounts",
]);

const BY_ID = new Map(ENDPOINTS.map((endpoint) => [endpoint.id.toLowerCase(), endpoint]));

export function isDestructive(endpoint: Endpoint): boolean {
  return endpoint.method === "DELETE" || /delete/i.test(endpoint.id) || DESTRUCTIVE_IDS.has(endpoint.id);
}

export function findEndpoint(id: string): Endpoint {
  const endpoint = BY_ID.get(String(id).toLowerCase());
  if (!endpoint) throw new Error(`Unknown Instantly operation "${id}". Use find-endpoints to list operation ids.`);
  return endpoint;
}

/** Fills {path} params and builds the query string, rejecting names the endpoint does not declare. */
export function buildUrl(endpoint: Endpoint, params: Record<string, unknown> = {}): string {
  const declared = new Map((endpoint.params ?? []).map((p) => [p.name, p]));
  const unknown = Object.keys(params).filter((name) => !declared.has(name));
  if (unknown.length) {
    throw new Error(`${endpoint.id} has no parameter ${unknown.join(", ")}. Valid: ${[...declared.keys()].join(", ") || "none"}.`);
  }
  const missing = (endpoint.params ?? []).filter((p) => p.required && (params[p.name] == null || params[p.name] === ""));
  if (missing.length) throw new Error(`${endpoint.id} requires ${missing.map((p) => `${p.in} parameter ${p.name}`).join(", ")}.`);

  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(String(params[name])));
  const qs = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value == null || declared.get(name)!.in !== "query") continue;
    // Instantly takes lists as comma-separated values.
    qs.set(name, Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return `${BASE_URL}${path}${qs.size ? `?${qs}` : ""}`;
}

function clip(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 1) ?? "null");
  if (text.length <= MAX_TOOL_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_CHARS)}\n…[truncated ${text.length - MAX_TOOL_CHARS} chars — use a smaller limit]`;
}

function header(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let ctx: PluginContext;

async function call(companyId: string, endpoint: Endpoint, params?: Record<string, unknown>, body?: unknown) {
  const cfg = (await ctx.config.get(companyId)) as InstantlyConfig;
  if (!cfg.apiKey) throw new Error("Instantly is not configured for this company: set apiKey.");
  if (isDestructive(endpoint) && !cfg.allowDestructive) {
    throw new Error(`${endpoint.id} is destructive and blocked. An operator can enable "Allow destructive operations" in the plugin settings.`);
  }
  const url = buildUrl(endpoint, params);
  const apiKey = await ctx.secrets.resolve(cfg.apiKey as never, { companyId, configPath: "apiKey" });
  // Instantly rejects a JSON content-type with an empty body, so only declare one when sending a body.
  const hasBody = body !== undefined && endpoint.method !== "GET";
  const res = await ctx.http.fetch(url, {
    method: endpoint.method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(hasBody && { "content-type": "application/json" }),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await readBody(res)) as any;
  if (!res.ok) {
    const message = typeof data === "string" ? data : (data?.message ?? data?.error ?? JSON.stringify(data));
    throw new Error(`Instantly API ${res.status}${res.status === 429 ? " (rate limited, retry shortly)" : ""}: ${message}`);
  }
  return data;
}

function registerTool(name: string, run: (params: any, companyId: string) => Promise<unknown>) {
  const declaration = manifest.tools!.find((tool) => tool.name === name)!;
  ctx.tools.register(name, declaration, async (params, runCtx): Promise<ToolResult> => {
    try {
      return { content: clip(await run(params ?? {}, runCtx.companyId)) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function issueDescription(event: InstantlyEvent): string {
  const lines: string[] = [`**Event:** ${event.event_type}`];
  if (event.campaign_name) lines.push(`**Campaign:** ${event.campaign_name} (${event.campaign_id})`);
  if (event.lead_email) lines.push(`**Lead:** ${event.lead_email}`);
  if (event.email_account) lines.push(`**Sending account:** ${event.email_account}`);
  if (event.unibox_url) lines.push(`**Unibox:** ${event.unibox_url}`);
  if (event.reply_subject) lines.push(`**Reply subject:** ${event.reply_subject}`);
  const reply = event.reply_text ?? event.reply_text_snippet;
  if (reply) lines.push("", "**Reply:**", "", String(reply).split("\n").map((line) => `> ${line}`).join("\n"));
  if (event.email_id && event.email_account) {
    lines.push(
      "",
      `To answer, call-endpoint \`replyToEmail\` with body \`{"reply_to_uuid": "${event.email_id}", "eaccount": "${event.email_account}", "subject": "Re: …", "body": {"text": "…"}}\`.`,
    );
  }
  lines.push("", "<details><summary>Raw event</summary>", "", "```json", JSON.stringify(event, null, 2), "```", "</details>");
  return lines.join("\n");
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;

    registerTool("find-endpoints", async ({ tag, query }) => {
      if (!tag && !query) {
        const counts: Record<string, number> = {};
        for (const endpoint of ENDPOINTS) counts[endpoint.tag] = (counts[endpoint.tag] ?? 0) + 1;
        return { total: ENDPOINTS.length, tags: counts, hint: "Pass tag and/or query to list operations." };
      }
      const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      return ENDPOINTS.filter((e) => !tag || e.tag.toLowerCase() === String(tag).toLowerCase())
        .filter((e) => words.every((w) => `${e.id} ${e.path} ${e.summary}`.toLowerCase().includes(w)))
        .map((e) => `${e.id}: ${e.method} ${e.path} — ${e.summary}${isDestructive(e) ? " [destructive]" : ""}`);
    });

    registerTool("describe-endpoint", async ({ id }) => {
      const endpoint = findEndpoint(id);
      // Compact JSON: the largest schemas (AI Lead Finder) only fit unindented.
      return JSON.stringify({ ...endpoint, destructive: isDestructive(endpoint) });
    });

    registerTool("call-endpoint", async ({ id, params, body }, companyId) => call(companyId, findEndpoint(id), params, body));
  },

  // Config is read per call, so there is nothing to reload; this stops the host restarting the worker on save.
  async onConfigChanged() {},

  async onWebhook(input) {
    // Plugin config is per company but the webhook route is per plugin, so Instantly sends the company as a custom header.
    const companyId = header(input.headers, "x-paperclip-company-id");
    if (!companyId) throw new Error("Missing x-paperclip-company-id header");
    const cfg = (await ctx.config.get(companyId)) as InstantlyConfig;
    if (!cfg.webhookSecret) throw new Error("webhookSecret is not configured; refusing Instantly webhook");
    const secret = await ctx.secrets.resolve(cfg.webhookSecret as never, { companyId, configPath: "webhookSecret" });
    if (!safeEqual(header(input.headers, "x-paperclip-webhook-secret") ?? "", secret)) {
      throw new Error("Invalid x-paperclip-webhook-secret");
    }

    const event = (input.parsedBody ?? {}) as InstantlyEvent;
    if (!event.event_type || !(cfg.issueEvents ?? DEFAULT_ISSUE_EVENTS).includes(event.event_type)) return;

    // Instantly retries failed deliveries with the same payload, so the body hash is the idempotency key.
    const key = createHash("sha256").update(input.rawBody).digest("hex").slice(0, 32);
    // ponytail: one state row per delivered event, never pruned; add a cleanup job if volume gets large
    const seen = { scopeKind: "company" as const, scopeId: companyId, namespace: "instantly-webhook", stateKey: key };
    if (await ctx.state.get(seen)) return;

    const who = event.lead_email ?? event.email_account ?? event.campaign_name ?? "workspace";
    await ctx.issues.create({
      companyId,
      title: `Instantly ${event.event_type.replace(/_/g, " ")}: ${who}`.slice(0, 200),
      description: issueDescription(event),
      projectId: cfg.issueProjectId || undefined,
      assigneeAgentId: cfg.issueAssigneeAgentId || undefined,
      originId: `instantly:${key}`,
    });
    await ctx.state.set(seen, new Date().toISOString());
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
