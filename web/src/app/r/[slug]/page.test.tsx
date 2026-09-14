import { createDb, orgs, type Db } from "@frontdesk/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import PublicFormPage, { dynamic, runtime } from "./page";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

describe.skipIf(!hasEnv)(
  hasEnv ? "/r/[slug] page" : "/r/[slug] page [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let realOrgSlug: string;
    let realOrgName: string;

    beforeAll(async () => {
      const ownerDb: Db = createDb(ownerUrl!);
      // Any org, not just the demo one - F1's public form isn't
      // demo-only. bright-smile-dental is seed data, so it exists, but
      // this looks it up rather than hardcoding the slug.
      const [row] = await ownerDb.select({ slug: orgs.slug, name: orgs.name }).from(orgs).limit(1);
      if (!row) throw new Error("expected at least one seeded org - run `pnpm seed` first");
      realOrgSlug = row.slug;
      realOrgName = row.name;
    });

    function renderPage(slug: string) {
      return PublicFormPage({ params: Promise.resolve({ slug }) });
    }

    it("segment config: Node runtime, never cached", () => {
      expect(runtime).toBe("nodejs");
      expect(dynamic).toBe("force-dynamic");
    });

    it("unknown org slug -> Next's notFound()", async () => {
      await expect(renderPage(`no-such-org-${Date.now()}`)).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
    });

    it("a real org's slug -> renders its name and the form for that slug", async () => {
      const html = renderToStaticMarkup(await renderPage(realOrgSlug));

      expect(html).toContain(realOrgName);
      // The Turnstile site key must reach the rendered widget div - a
      // missing key would silently ship a form with no working challenge.
      expect(html).toContain("cf-turnstile");
      expect(html).toContain(`name="subject"`);
      expect(html).toContain(`name="body"`);
    });
  },
);
