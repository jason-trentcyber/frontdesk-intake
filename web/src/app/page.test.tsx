import { randomUUID } from "node:crypto";
import { createDb, orgs, requests, type Db } from "@frontdesk/db";
import { eq, inArray } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import HomePage, { dynamic, runtime } from "./page";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

describe.skipIf(!hasEnv)(
  hasEnv
    ? "/ landing page (F16)"
    : "/ landing page (F16) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let demoOrgId: string;
    let demoOrgName: string;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const [demo] = await ownerDb
        .select({ id: orgs.id, slug: orgs.slug, name: orgs.name })
        .from(orgs)
        .where(eq(orgs.isDemo, true))
        .limit(1);
      if (!demo) throw new Error("expected a demo org (is_demo) - run `pnpm seed` first");
      demoOrgId = demo.id;
      demoOrgName = demo.name;
    });

    afterEach(async () => {
      if (createdRequestIds.length > 0) {
        await ownerDb.delete(requests).where(inArray(requests.id, createdRequestIds));
        createdRequestIds.length = 0;
      }
    });

    async function makeRequest(overrides: Partial<typeof requests.$inferInsert> = {}) {
      const [row] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: "landing page test subject",
          body: "landing page test body",
          trackingToken: `landing-test-${randomUUID()}`,
          status: "received",
          ...overrides,
        })
        .returning();
      if (!row) throw new Error("failed to insert test request");
      createdRequestIds.push(row.id);
      return row;
    }

    it("segment config: Node runtime, never cached", () => {
      expect(runtime).toBe("nodejs");
      expect(dynamic).toBe("force-dynamic");
    });

    it("always renders the demo org's form and the project links, regardless of queue contents", async () => {
      const html = renderToStaticMarkup(await HomePage());

      expect(html).toContain(demoOrgName);
      expect(html).toContain("cf-turnstile");
      expect(html).toContain("github.com/jason-trentcyber/frontdesk-intake");
      expect(html).toContain("github.com/users/jason-trentcyber/projects/1");
    });

    it("a drafted request with a real, distinctive draft-adjacent name/email -> never appears in the rendered page", async () => {
      const secretName = `SECRET-NAME-${randomUUID()}`;
      const secretEmail = `secret-${randomUUID()}@example.com`;
      await makeRequest({
        status: "drafted",
        requesterName: secretName,
        requesterEmail: secretEmail,
      });

      const html = renderToStaticMarkup(await HomePage());

      expect(html).not.toContain(secretName);
      expect(html).not.toContain(secretEmail);
    });

    it("an approved request's reply text appears in the rendered queue", async () => {
      const replyText = `approved landing page reply ${randomUUID()}`;
      await makeRequest({ status: "approved", replyText });

      const html = renderToStaticMarkup(await HomePage());

      expect(html).toContain(replyText);
    });
  },
);
