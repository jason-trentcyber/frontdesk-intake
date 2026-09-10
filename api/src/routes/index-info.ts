import { chunks, documents, forOrg, orgs, type Db } from "@frontdesk/db";
import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { sendProblem } from "../problem.js";

// F15: chunking strategy, embedding model, and index parameters are
// documented in ADR-0005 - static here, not read off the schema, since
// they describe how chunks got the shape they have, not a live setting.
const INDEX_INFO_STATIC = {
  embeddingModel: "BAAI/bge-small-en-v1.5",
  embeddingDimensions: 384,
  chunking: {
    strategy: "markdown-aware",
    targetTokens: 400,
    overlapTokens: 60,
  },
  index: {
    type: "hnsw",
    distance: "cosine",
    m: 16,
    efConstruction: 64,
  },
} as const;

export function registerIndexInfoRoute(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { slug: string } }>("/api/v1/orgs/:slug/index-info", async (req, reply) => {
    const { slug } = req.params;

    const [org] = await db.select().from(orgs).where(eq(orgs.slug, slug));
    // F15: "for the demo" - any non-demo org 404s, same as an org that
    // doesn't exist at all (never confirm a private org's slug is real).
    if (!org || !org.isDemo) {
      return sendProblem(reply, 404, "Not Found", `no such org: ${slug}`);
    }

    // AGENTS.md: "Every query on a tenant table includes org_id. No
    // exceptions (ADR-0007)." RLS would scope these counts on its own,
    // but the rule is belt and braces (ADR-0018) - forOrg hands orgId
    // back precisely so the filter is visible in the query.
    const counts = await forOrg(db, org.id, async (tx, orgId) => {
      const [documentCount] = await tx
        .select({ value: count() })
        .from(documents)
        .where(eq(documents.orgId, orgId));
      const [chunkCount] = await tx
        .select({ value: count() })
        .from(chunks)
        .where(eq(chunks.orgId, orgId));
      return {
        documentCount: documentCount?.value ?? 0,
        chunkCount: chunkCount?.value ?? 0,
      };
    });

    return { ...INDEX_INFO_STATIC, ...counts };
  });
}
