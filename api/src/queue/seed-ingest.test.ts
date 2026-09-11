import { randomUUID } from "node:crypto";
import { createDb, documents, forOrg, orgs, type Db } from "@frontdesk/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { enqueuePendingIngestMessages } from "./seed-ingest.js";
import type { IngestMessage, Queue } from "./index.js";

const appUrl = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
const hasEnv = Boolean(appUrl);

class FakeQueue implements Queue<IngestMessage> {
  sent: IngestMessage[] = [];
  async send(payload: IngestMessage): Promise<string> {
    this.sent.push(payload);
    return randomUUID();
  }
  async receive(): Promise<never[]> {
    return [];
  }
  async ack(): Promise<void> {}
  async nack(): Promise<void> {}
  async deadLetter(): Promise<void> {}
}

describe.skipIf(!hasEnv)(
  hasEnv
    ? "enqueuePendingIngestMessages"
    : "enqueuePendingIngestMessages [skipped: DATABASE_APP_URL/DATABASE_URL not set]",
  () => {
    let db: Db;
    let demoOrgId: string;

    beforeAll(async () => {
      db = createDb(appUrl!);
      const [org] = await db
        .select({ id: orgs.id })
        .from(orgs)
        .where(eq(orgs.slug, "bright-smile-dental"));
      if (!org) {
        throw new Error("seed data missing: bright-smile-dental (run `pnpm seed` first)");
      }
      demoOrgId = org.id;
    });

    it("enqueues one message per pending document and skips non-pending ones", async () => {
      const [pendingDoc, indexedDoc] = await forOrg(db, demoOrgId, async (tx) => {
        const [a] = await tx
          .insert(documents)
          .values({
            orgId: demoOrgId,
            title: "seed-ingest-test pending",
            filename: "pending.md",
            mime: "text/markdown",
            sha256: randomUUID(),
            raw: Buffer.from("hello"),
            status: "pending",
          })
          .returning({ id: documents.id });
        const [b] = await tx
          .insert(documents)
          .values({
            orgId: demoOrgId,
            title: "seed-ingest-test indexed",
            filename: "indexed.md",
            mime: "text/markdown",
            sha256: randomUUID(),
            raw: Buffer.from("hello"),
            status: "indexed",
          })
          .returning({ id: documents.id });
        return [a, b];
      });
      if (!pendingDoc || !indexedDoc) {
        throw new Error("insert into documents returned no row");
      }

      try {
        const queue = new FakeQueue();

        const enqueued = await enqueuePendingIngestMessages(db, queue);

        expect(enqueued).toBeGreaterThanOrEqual(1);
        const docIdsForDemoOrg = queue.sent
          .filter((m) => m.orgId === demoOrgId)
          .map((m) => m.documentId);
        expect(docIdsForDemoOrg).toContain(pendingDoc.id);
        expect(docIdsForDemoOrg).not.toContain(indexedDoc.id);
        // Every sent message validates against the committed contract -
        // assertIngestMessage inside enqueuePendingIngestMessages already
        // guarantees this, but asserting the shape here documents it.
        for (const message of queue.sent) {
          expect(typeof message.orgId).toBe("string");
          expect(typeof message.documentId).toBe("string");
        }
      } finally {
        await forOrg(db, demoOrgId, async (tx) => {
          await tx.delete(documents).where(eq(documents.id, pendingDoc.id));
          await tx.delete(documents).where(eq(documents.id, indexedDoc.id));
        });
      }
    });
  },
);
