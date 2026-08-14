import type { TriggerDef } from "@repo/core";

// Incoming webhook trigger — trigger class B (docs/02-architecture.md).
// The engine exposes `POST /hooks/wh_{uuid}`, validates the HMAC signature,
// and passes the parsed raw request to `perform` as the trigger payload.
export const webhook: TriggerDef = {
  key: "webhook",
  noun: "Webhook",
  type: "WEBHOOK",
  operation: {
    inputFields: [
      { key: "method", type: "string", default: "POST", helpText: "HTTP method the webhook responds to" },
    ],
    sample: { id: "evt_1", event: "issue.opened", payload: { title: "Example issue" } },
    perform: async ({ rawRequest }) => {
      // The engine delivers the parsed body verbatim; nothing to transform here.
      return rawRequest;
    },
  },
};
