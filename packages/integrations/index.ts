// The registry — every trigger/action definition, one file each.
// The worker looks up by key; the API serves these to the builder UI
// (GET /triggers, GET /actions). Adding an integration = one file + one row.

import { webhook } from "./triggers/webhook";
import { httpRequest } from "./actions/http-request";

export const triggers: Record<string, typeof webhook> = {
  [webhook.key]: webhook,
};

export const actions: Record<string, typeof httpRequest> = {
  [httpRequest.key]: httpRequest,
};
