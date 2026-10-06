# paperclip-plugin-instantly

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that connects agents and [Instantly.ai](https://instantly.ai) in both directions:

- **Agents → Instantly**: agents can call **every Instantly API v2 endpoint (255 operations)**. That covers campaigns, leads and lead lists, Unibox emails and replies, sending accounts and warmup, analytics, block lists, inbox placement tests, subsequences, email verification, webhooks, workspace and members, the AI Sales, Inbox Manager, Lead Finder and Deliverability agents, SuperSearch enrichment and company lists.
- **Instantly → Paperclip**: Instantly webhooks such as replies, interested leads or booked meetings open Paperclip issues, optionally assigned to an agent.

## Install

```bash
npm install && npm run build
paperclipai plugin install /absolute/path/to/paperclip-plugin-instantly
```

## Configure (per company)

| Field | Notes |
|---|---|
| Instantly API key | An API **v2** key from **Settings → Integrations → API Keys**, sent as `Authorization: Bearer`. The key's scopes are the main permission boundary. To keep agents read-only, give them a read-only key. |
| Allow destructive operations | Off by default. When off, the plugin refuses every `DELETE`, every `*delete*` operation, workspace removal, owner changes, API key creation, account moves, lead merges, and paid DFY orders or cancellations. |
| Webhook secret | Needed for Instantly → Paperclip. |
| Webhook events that open issues | Default: `reply_received`, `lead_interested`, `lead_meeting_booked`. Any `event_type` works, including custom lead label names. |
| Paperclip project / agent for webhook issues | Optional. The assigned agent is woken for each issue. |

## Agent tools

The API has 255 operations. Registering one tool per operation would put every schema into each agent's context, so the plugin exposes the full API through three tools:

| Tool | What it does |
|---|---|
| `find-endpoints` | With no arguments, lists the resources (tags) and how many operations each has. Takes `tag` and/or `query` (e.g. `{tag: "Lead"}`, `{query: "warmup"}`) and returns `operationId: METHOD /path — summary`. |
| `describe-endpoint` | Returns one operation's path and query parameters and its request body JSON schema. |
| `call-endpoint` | `{id, params, body}`. Path and query parameters go in `params`, and the JSON body goes in `body`. Unknown or missing parameters are rejected with the list of valid ones. Lists are paged with `limit` and `starting_after` (pass the response's `next_starting_after`). |

Examples:

```jsonc
{ "id": "listCampaign", "params": { "limit": 20, "status": 1 } }
{ "id": "getCampaignAnalytics", "params": { "id": "<campaign id>" } }
{ "id": "listLeads", "body": { "campaign": "<campaign id>", "filter": "FILTER_LEAD_INTERESTED", "limit": 50 } }
{ "id": "bulkAddLeads", "body": { "campaign_id": "<id>", "leads": [{ "email": "jane@acme.com", "first_name": "Jane" }] } }
{ "id": "replyToEmail", "body": { "reply_to_uuid": "<email id>", "eaccount": "me@acme.com", "subject": "Re: …", "body": { "text": "…" } } }
```

The catalog is generated from Instantly's OpenAPI spec (`https://api.instantly.ai/openapi/api_v2.json`). When Instantly adds endpoints, refresh it:

```bash
npm run generate && npm test && npm run build
```

## Instantly → Paperclip

Create the webhook in Instantly (**Settings → Integrations → Webhooks**). An agent can also do it with `call-endpoint` `createWebhook`:

```json
{
  "target_hook_url": "https://<your-paperclip-host>/api/plugins/domgolonka.paperclip-plugin-instantly/webhooks/events",
  "event_type": "all_events",
  "headers": {
    "x-paperclip-company-id": "<company id>",
    "x-paperclip-webhook-secret": "<webhook secret>"
  }
}
```

- Events listed under *Webhook events that open issues* become issues. All other events are acknowledged and ignored.
- The issue includes the campaign, the lead, the quoted reply text, a Unibox link and a ready-made `replyToEmail` call. An assigned agent can therefore read the reply and answer it in the same thread.
- Instantly retries failed deliveries. Repeats of the same payload are deduplicated.
- Instantly must be able to reach your Paperclip host. A `localhost` Paperclip will not receive webhooks.

## Development

```bash
npm run dev        # esbuild watch; Paperclip reloads the worker on rebuild
npm test
npm run typecheck
```

Not included yet:
- Polling as an alternative to webhooks for private Paperclip instances, as the Sanity plugin does. It could poll `listEmail` for new replies.
- Forwarding Paperclip events to Instantly. Nothing in Instantly consumes them.
- Automatic retry on `429` rate limits. The error goes back to the agent, which can retry.
