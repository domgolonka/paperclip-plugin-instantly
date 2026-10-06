import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "domgolonka.paperclip-plugin-instantly",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Instantly",
  description:
    "Instantly.ai connector: agents can call every Instantly API v2 endpoint (campaigns, leads, Unibox email, accounts, analytics, AI agents, SuperSearch and more). Instantly webhooks such as replies and interested leads open Paperclip issues.",
  author: "Dominik Golonka",
  categories: ["connector"],
  capabilities: [
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "issues.create",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    required: ["apiKey"],
    properties: {
      apiKey: {
        format: "secret-ref",
        title: "Instantly API key",
        description:
          "API v2 key from Instantly under Settings > Integrations > API Keys. Its scopes set what agents can do; a read-only key keeps agents read-only.",
      },
      allowDestructive: {
        type: "boolean",
        title: "Allow destructive operations",
        description:
          "Off by default. When off, agents cannot delete anything, remove the workspace, change its owner, create API keys, move accounts, merge leads, or place or cancel paid DFY orders.",
        default: false,
      },
      webhookSecret: {
        format: "secret-ref",
        title: "Webhook secret",
        description:
          "Instantly must send this in the x-paperclip-webhook-secret header (set it under the webhook's custom headers). Webhooks are rejected until this is set.",
      },
      issueEvents: {
        type: "array",
        title: "Webhook events that open issues",
        description:
          "Instantly event_type values, e.g. reply_received, lead_interested, lead_meeting_booked, email_bounced, account_error. Custom lead labels arrive under their own name.",
        items: { type: "string" },
        default: ["reply_received", "lead_interested", "lead_meeting_booked"],
      },
      issueProjectId: {
        type: "string",
        title: "Paperclip project for webhook issues",
        description: "Optional. Issues opened from Instantly webhooks go to this project.",
      },
      issueAssigneeAgentId: {
        type: "string",
        title: "Agent to assign webhook issues to",
        description: "Optional. This Paperclip agent is assigned to (and woken for) each webhook issue.",
      },
    },
  },
  webhooks: [
    {
      endpointKey: "events",
      displayName: "Instantly events",
      description:
        "Point an Instantly webhook here. Add custom headers x-paperclip-company-id (your company ID) and x-paperclip-webhook-secret.",
    },
  ],
  tools: [
    {
      name: "find-endpoints",
      displayName: "Instantly: find API endpoints",
      description:
        "Search the Instantly API v2 catalog. With no arguments, lists every resource (tag) with its endpoint count. Filter by tag (e.g. Campaign, Lead, Email, Account) and/or a query matched against the operation id, path and summary. Returns operation ids to pass to describe-endpoint and call-endpoint.",
      parametersSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Resource tag, case-insensitive, e.g. Lead or AISalesAgent." },
          query: { type: "string", description: "Words that must all appear, e.g. \"reply email\" or \"warmup\"." },
        },
      },
    },
    {
      name: "describe-endpoint",
      displayName: "Instantly: describe API endpoint",
      description:
        "Show one Instantly endpoint's method, path, path and query parameters, and request body JSON schema. Read this before call-endpoint.",
      parametersSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Operation id from find-endpoints, e.g. listCampaign." } },
        required: ["id"],
      },
    },
    {
      name: "call-endpoint",
      displayName: "Instantly: call API endpoint",
      description:
        "Call any Instantly API v2 endpoint by operation id. Put path and query parameters in params (e.g. {\"id\": \"…\", \"limit\": 20}) and the JSON request body in body. Lists are paged: pass the response's next_starting_after as params.starting_after.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Operation id, e.g. listCampaign, replyToEmail, bulkAddLeads." },
          params: { type: "object", description: "Path and query parameters by name." },
          body: { description: "JSON request body, for endpoints that take one." },
        },
        required: ["id"],
      },
    },
  ],
};

export default manifest;
