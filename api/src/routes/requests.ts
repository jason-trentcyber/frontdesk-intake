import { randomUUID } from "node:crypto";
import { forOrg, orgs, requests, resolveApiKey, type Db } from "@frontdesk/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashApiKey } from "../api-key.js";
import { sendProblem } from "../problem.js";
import { assertTriageMessage, type Queue, type TriageMessage } from "../queue/index.js";
import type { TurnstileVerifier } from "../turnstile.js";

const bodySchema = z.object({
  // F1: name and email are both optional on the public form.
  requesterName: z.string().trim().min(1).optional(),
  requesterEmail: z.string().trim().email().optional(),
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
  "cf-turnstile-response": z.string().min(1).optional(),
});

export interface RequestsRouteDeps {
  db: Db;
  queue: Queue<TriageMessage>;
  verifyTurnstile: TurnstileVerifier;
  publicWebOrigin: string;
}

async function getOrgBySlug(db: Db, slug: string) {
  const [org] = await db.select().from(orgs).where(eq(orgs.slug, slug));
  return org ?? null;
}

export function registerRequestsRoute(app: FastifyInstance, deps: RequestsRouteDeps): void {
  const { db, queue, verifyTurnstile, publicWebOrigin } = deps;

  app.post<{ Params: { slug: string } }>("/api/v1/orgs/:slug/requests", async (req, reply) => {
    const { slug } = req.params;

    // Exactly one auth mode per request (F1 Turnstile, F3 API key); both
    // present or neither -> 400.
    const authHeader = req.headers.authorization;
    const hasApiKey =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ") && authHeader.length > 7;
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const turnstileToken = rawBody["cf-turnstile-response"];
    const hasTurnstile = typeof turnstileToken === "string" && turnstileToken.length > 0;

    if (hasApiKey === hasTurnstile) {
      return sendProblem(
        reply,
        400,
        "Bad Request",
        "exactly one of an API key (Authorization: Bearer <key>) or cf-turnstile-response is required",
      );
    }

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return sendProblem(reply, 400, "Bad Request", z.prettifyError(parsed.error));
    }
    const { requesterName, requesterEmail, subject, body } = parsed.data;

    let orgId: string;
    let source: "api" | "form";

    if (hasApiKey) {
      const key = authHeader!.slice("Bearer ".length).trim();
      const resolved = await resolveApiKey(db, hashApiKey(key));
      if (!resolved) {
        return sendProblem(reply, 401, "Unauthorized", "invalid or revoked API key");
      }
      // The resolved org must match :slug - 404, not 403, so an
      // authenticated-but-wrong-org caller learns nothing about whether
      // a different org owns this slug (brief, ADR-0021's audience model).
      const org = await getOrgBySlug(db, slug);
      if (!org || org.id !== resolved.orgId) {
        return sendProblem(reply, 404, "Not Found", `no such org: ${slug}`);
      }
      orgId = resolved.orgId;
      source = "api";
    } else {
      const ok = await verifyTurnstile(turnstileToken as string, req.ip);
      if (!ok) {
        return sendProblem(reply, 403, "Forbidden", "Turnstile verification failed");
      }
      const org = await getOrgBySlug(db, slug);
      if (!org) {
        return sendProblem(reply, 404, "Not Found", `no such org: ${slug}`);
      }
      orgId = org.id;
      source = "form";
    }

    const trackingToken = randomUUID();

    const requestId = await forOrg(db, orgId, async (tx) => {
      const [inserted] = await tx
        .insert(requests)
        .values({
          orgId,
          source,
          requesterName: requesterName ?? null,
          requesterEmail: requesterEmail ?? null,
          subject,
          body,
          trackingToken,
        })
        .returning({ id: requests.id });
      if (!inserted) {
        throw new Error("insert into requests returned no row");
      }
      return inserted.id;
    });

    // Enqueue AFTER the transaction commits, not inside it: a
    // rolled-back insert must not leave a queued message pointing at a
    // request row that was never actually created (brief, judgment call
    // in the PR body).
    const message: TriageMessage = { orgId, requestId };
    // The queue has no RLS (see queue/index.ts): an unscoped message would
    // be accepted silently. Fail here instead, before it is durable.
    assertTriageMessage(message);
    await queue.send(message);

    return reply.code(201).send({
      trackingToken,
      trackingUrl: `${publicWebOrigin}/t/${trackingToken}`,
    });
  });
}
