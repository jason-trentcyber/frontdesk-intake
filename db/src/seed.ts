import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import { logger } from "./logger.js";
import * as schema from "./schema/index.js";
import type { OrgSettings } from "./settings.js";

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed");
const SEED_OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";

// org_members.email is globally unique (ADR-0018), so both orgs' owners
// can't literally share SEED_OWNER_EMAIL. Plus-addressing derives a
// distinct, valid address per org from the one inbox a human configures -
// mail to either still lands in SEED_OWNER_EMAIL's inbox.
function ownerEmailFor(orgSlug: string): string {
  const at = SEED_OWNER_EMAIL.indexOf("@");
  if (at === -1) return SEED_OWNER_EMAIL;
  return `${SEED_OWNER_EMAIL.slice(0, at)}+${orgSlug}${SEED_OWNER_EMAIL.slice(at)}`;
}

interface OrgSeed {
  slug: string;
  name: string;
  isDemo: boolean;
  settings: OrgSettings;
}

const ORGS: OrgSeed[] = [
  {
    slug: "bright-smile-dental",
    name: "Bright Smile Dental",
    isDemo: true,
    settings: {
      categories: ["scheduling", "billing", "insurance", "clinical-question", "other"],
      lanes: {
        scheduling: "front-desk",
        billing: "billing",
        insurance: "billing",
        "clinical-question": "clinical",
        other: "front-desk",
      },
    },
  },
  {
    slug: "harbor-legal",
    name: "Harbor Legal",
    isDemo: false,
    settings: {
      categories: ["scheduling", "billing", "intake", "case-question", "other"],
      lanes: {
        scheduling: "front-desk",
        billing: "billing",
        intake: "intake",
        "case-question": "attorney",
        other: "front-desk",
      },
    },
  },
];

interface DemoRequestSeed {
  trackingToken: string;
  requesterName: string | null;
  requesterEmail: string | null;
  subject: string;
  body: string;
  status: "received" | "triaging" | "drafted" | "needs_human" | "approved" | "rejected";
  category: string;
  urgency: "low" | "normal" | "high";
  summary: string;
  draftBody: string;
  approved: boolean;
}

// ~6 fictional demo-org requests (ADR-0018 §Seeds) so the landing-page
// queue (F16) has content before the worker exists (#24). Only the demo
// org gets these - harbor-legal is the private org, not shown publicly.
const DEMO_REQUESTS: DemoRequestSeed[] = [
  {
    trackingToken: "seed-bsd-reschedule-cleaning",
    requesterName: "Priya Natarajan",
    requesterEmail: "priya.natarajan@example.com",
    subject: "Need to reschedule my cleaning",
    body: "Hi, I have a cleaning booked for this Thursday at 2pm but I have a work conflict. Could I move it to next week sometime in the afternoon?",
    status: "approved",
    category: "scheduling",
    urgency: "low",
    summary: "Patient requests to reschedule an upcoming cleaning appointment.",
    draftBody:
      "Thanks for letting us know! We'd be happy to move your cleaning to next week. Please give the front desk a call or reply here with a couple of afternoon times that work for you and we'll get you booked in.",
    approved: true,
  },
  {
    trackingToken: "seed-bsd-delta-dental-coverage",
    requesterName: "Marcus Webb",
    requesterEmail: "marcus.webb@example.com",
    subject: "Do you take Delta Dental?",
    body: "I just got new insurance through my job, Delta Dental PPO. Are you in-network with that plan? I'm due for a cleaning.",
    status: "approved",
    category: "insurance",
    urgency: "normal",
    summary: "Prospective/existing patient asks whether Delta Dental PPO is in-network.",
    draftBody:
      "Great news — we're in-network with Delta Dental PPO! Bring your insurance card to your visit and we'll verify your specific benefits and get you an estimate before any treatment.",
    approved: true,
  },
  {
    trackingToken: "seed-bsd-filling-cost-no-insurance",
    requesterName: null,
    requesterEmail: null,
    subject: "Cost of a filling without insurance",
    body: "How much would a regular cavity filling cost if I don't have dental insurance? Just trying to budget ahead of time.",
    status: "approved",
    category: "billing",
    urgency: "normal",
    summary: "Anonymous inquiry about the self-pay cost of a single filling.",
    draftBody:
      "Happy to help you budget! Without insurance, a single-surface composite filling is typically in the $180–$240 range before our 15% courtesy discount for payment in full at the time of service. The exact price depends on the tooth and how many surfaces are involved, which we can confirm at an exam.",
    approved: true,
  },
  {
    trackingToken: "seed-bsd-toothache-emergency",
    requesterName: "Dana Ferreira",
    requesterEmail: "dana.ferreira@example.com",
    subject: "Bad toothache, not sure if this is an emergency",
    body: "I've had a throbbing pain in my lower left molar since last night and it's getting worse. No swelling that I can see. Is this something I need to be seen for today?",
    status: "needs_human",
    category: "clinical-question",
    urgency: "high",
    summary: "Patient reports worsening tooth pain, asking whether same-day care is needed.",
    draftBody:
      "A worsening, throbbing toothache can indicate an infection and is worth same-day attention even without visible swelling. Please call the office line as soon as you can so we can fit you in today; if swelling, fever, or difficulty swallowing develops before then, that's a sign to seek urgent or emergency care right away.",
    approved: false,
  },
  {
    trackingToken: "seed-bsd-holiday-hours",
    requesterName: "Tom Okafor",
    requesterEmail: "tom.okafor@example.com",
    subject: "Are you open the day after Thanksgiving?",
    body: "Planning some time off and want to know if the office is open the Friday after Thanksgiving in case I need to squeeze in an appointment.",
    status: "approved",
    category: "other",
    urgency: "low",
    summary: "Patient asks about holiday hours around Thanksgiving.",
    draftBody:
      "We're closed both Thanksgiving Day and the day after this year, so the Friday won't work I'm afraid — but we'd be glad to find you a spot the week before or the following week if that helps with your plans!",
    approved: true,
  },
  {
    trackingToken: "seed-bsd-xray-copies",
    requesterName: "Lena Kowalski",
    requesterEmail: "lena.kowalski@example.com",
    subject: "Can I get a copy of my X-rays?",
    body: "I'm switching to a dentist closer to my new place and need copies of my most recent X-rays sent over. What's the process for that?",
    status: "drafted",
    category: "other",
    urgency: "low",
    summary: "Patient requests a copy of their X-rays be sent to a new dentist.",
    draftBody:
      "Of course! Send us the name and fax or email of your new dentist's office and a signed records-release request (we can email you the form), and we'll get your X-rays and a summary of your records over to them within a few business days.",
    approved: false,
  },
];

async function upsertOrg(db: Db, org: OrgSeed): Promise<{ id: string; inserted: boolean }> {
  const inserted = await db
    .insert(schema.orgs)
    .values({
      slug: org.slug,
      name: org.name,
      isDemo: org.isDemo,
      settings: org.settings,
    })
    .onConflictDoNothing({ target: schema.orgs.slug })
    .returning({ id: schema.orgs.id });

  if (inserted[0]) {
    return { id: inserted[0].id, inserted: true };
  }
  const [existing] = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.slug, org.slug));
  if (!existing) {
    throw new Error(`org ${org.slug} missing immediately after a no-op insert`);
  }
  return { id: existing.id, inserted: false };
}

async function upsertOwner(db: Db, orgId: string, orgSlug: string): Promise<boolean> {
  const email = ownerEmailFor(orgSlug);
  const inserted = await db
    .insert(schema.orgMembers)
    .values({ orgId, email, role: "owner" })
    .onConflictDoNothing({ target: schema.orgMembers.email })
    .returning({ id: schema.orgMembers.id });
  return inserted.length > 0;
}

async function upsertDocuments(db: Db, orgId: string, orgSlug: string): Promise<number> {
  const dir = path.join(SEED_DIR, orgSlug);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();

  let created = 0;
  for (const filename of files) {
    const filePath = path.join(dir, filename);
    const content = await readFile(filePath, "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const titleMatch = /^#\s+(.+)$/m.exec(content);
    const title = titleMatch?.[1] ?? filename;

    const inserted = await db
      .insert(schema.documents)
      .values({
        orgId,
        title,
        filename,
        mime: "text/markdown",
        sha256,
        raw: Buffer.from(content, "utf8"),
        textContent: content,
        status: "pending",
      })
      .onConflictDoNothing({ target: [schema.documents.orgId, schema.documents.sha256] })
      .returning({ id: schema.documents.id });

    if (inserted[0]) {
      created += 1;
    }
  }
  return created;
}

async function upsertDemoRequests(db: Db, orgId: string): Promise<number> {
  let created = 0;
  for (const seed of DEMO_REQUESTS) {
    const inserted = await db
      .insert(schema.requests)
      .values({
        orgId,
        source: "form",
        requesterName: seed.requesterName,
        requesterEmail: seed.requesterEmail,
        subject: seed.subject,
        body: seed.body,
        trackingToken: seed.trackingToken,
        status: seed.status,
        category: seed.category,
        urgency: seed.urgency,
        summary: seed.summary,
        lane: ORGS[0]!.settings.lanes[seed.category],
        replyText: seed.approved ? seed.draftBody : null,
        resolvedAt: seed.approved ? new Date() : null,
      })
      // tracking_token is globally unique, not (org_id, tracking_token) -
      // it's the /t/<token> URL, which isn't itself org-scoped (F2).
      .onConflictDoNothing({ target: schema.requests.trackingToken })
      .returning({ id: schema.requests.id });

    const request = inserted[0];
    if (!request) {
      continue; // already seeded, including its draft (and action, if approved)
    }
    created += 1;

    await db.insert(schema.drafts).values({
      orgId,
      requestId: request.id,
      version: 1,
      body: seed.draftBody,
      citations: [],
      confidence: "0",
      model: "seed",
      promptVersion: "seed",
      tokensIn: 0,
      tokensOut: 0,
    });

    if (seed.approved) {
      await db.insert(schema.actions).values({
        orgId,
        requestId: request.id,
        actorEmail: ownerEmailFor(ORGS[0]!.slug),
        kind: "approve",
        before: { status: "drafted" },
        after: { status: "approved" },
        reason: null,
      });
    }
  }
  return created;
}

export interface SeedCounts {
  orgs: number;
  owners: number;
  documents: number;
  requests: number;
}

/** Idempotent: create-if-missing by natural key, never overwrites (ADR-0018). */
export async function seedDatabase(db: Db): Promise<SeedCounts> {
  const counts: SeedCounts = { orgs: 0, owners: 0, documents: 0, requests: 0 };

  for (const org of ORGS) {
    const { id: orgId, inserted: orgInserted } = await upsertOrg(db, org);
    if (orgInserted) counts.orgs += 1;

    if (await upsertOwner(db, orgId, org.slug)) counts.owners += 1;
    counts.documents += await upsertDocuments(db, orgId, org.slug);

    if (org.isDemo) {
      counts.requests += await upsertDemoRequests(db, orgId);
    }
  }

  return counts;
}

// Only run as a CLI entrypoint (`pnpm seed`), not when seed.test.ts imports
// seedDatabase directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required (see .env.example)");
  }
  seedDatabase(createDb(url))
    .then((counts) => logger.info("seed complete", { ...counts }))
    .catch((err: unknown) => {
      logger.error("seed failed", { error: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    });
}
