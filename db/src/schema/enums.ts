import { pgEnum } from "drizzle-orm/pg-core";

export const memberRole = pgEnum("member_role", ["owner", "staff"]);

export const requestSource = pgEnum("request_source", ["form", "api"]);

export const requestStatus = pgEnum("request_status", [
  "received",
  "triaging",
  "drafted",
  "needs_human",
  "approved",
  "rejected",
]);

export const requestUrgency = pgEnum("request_urgency", ["low", "normal", "high"]);

export const actionKind = pgEnum("action_kind", ["approve", "edit", "reject"]);

export const documentStatus = pgEnum("document_status", ["pending", "indexed", "failed"]);
