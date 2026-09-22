import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

// #29 stage 1 (ADR-0038 §2): request correlation for api/.
//
// Fastify's `logger: true` already emits structured JSON via pino - that
// half of docs/conventions.md was already satisfied here (unlike worker/,
// see worker/frontdesk_worker/logging_config.py). What it does not give is
// a correlation id worth following across a hop:
//
//   {"level":30,...,"reqId":"req-1","msg":"incoming request"}
//
// `req-1` is a per-process counter. It restarts at 1 on every pod restart
// and every replica mints the same ids, so two unrelated requests in one
// log stream are indistinguishable - which is the one thing a correlation
// id exists to prevent. A UUID costs nothing here (one per request, not
// per log line) and is unique across pods, restarts and replicas.

/** Header a caller (or the edge) may set to propagate its own id. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Cap on an accepted inbound id. Length only - see sanitizeRequestId. */
export const MAX_REQUEST_ID_LENGTH = 128;

// Accepted characters for an inbound id: the printable, unambiguous subset
// that covers a UUID, a Cloudflare ray id, a W3C traceparent's trace-id and
// anything else a sane caller sends. Deliberately a positive allow-list
// rather than a denylist of control characters:
//
// - A log line is JSON (pino here, JsonFormatter in the worker), so a
//   newline in a field value is escaped rather than emitted raw, and cannot
//   forge a second log record. That is the *serializer's* guarantee though,
//   not this module's, and the same id is going to be read by grep, by
//   Loki's line parser (#29 stage 3) and by a human in a terminal. An id
//   that is safe only because one specific serializer escapes it is a
//   latent problem for the next consumer.
// - The value is attacker-controlled on the public intake path, which is
//   reachable unauthenticated (Turnstile only). Accepting an arbitrary
//   128-byte blob into every log line for a request is free log-spam
//   amplification with no upside.
//
// An id that fails either check is not an error - the caller gets a
// generated one instead, silently. Rejecting the request over a log field
// would turn an observability nicety into an availability risk.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]+$/;

/**
 * Returns `value` if it is usable as a correlation id, otherwise null.
 * Exported for its own test: the validation, not the generation, is the
 * part with an attacker on the other end of it.
 */
export function sanitizeRequestId(value: unknown): string | null {
  if (typeof value !== "string") {
    // Fastify hands back an array when a header appears twice. Ambiguous
    // provenance - generate instead of picking one arbitrarily.
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }
  if (!SAFE_REQUEST_ID.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Fastify's `genReqId`. Honours a caller-supplied `x-request-id` when it
 * passes sanitizeRequestId, so a request can be followed from the edge
 * through api/ and (via the enqueued message's own ids) into worker/.
 * Generates a UUID otherwise.
 */
export function genReqId(req: { headers: FastifyRequest["headers"] }): string {
  return sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
}
