import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createDb, forOrg, type Db } from "./client.js";
import { logger } from "./logger.js";
import { actions, drafts, orgs, requests } from "./schema/index.js";

// F13 / #31: staff edits and rejections become *candidate* eval examples.
//
// The `actions` table already is the export table the issue asked for -
// every edit/reject row carries who, when, the before/after reply text and
// the reject reason (F12, ADR-0018). This module joins those rows to the
// request they concern and writes them in the golden-set line shape
// (evals/golden/*.jsonl, ADR-0036) plus a `provenance` block that says
// what the human actually did.
//
// Two things are deliberately NOT done here:
//
// 1. Nothing is written into evals/golden/. Staff cannot relabel category
//    or urgency in the UI (the detail page renders them read-only), so an
//    edit or reject tells us the *draft* was wrong - it does not tell us the
//    category was. `expected_category`/`expected_urgency` below are the
//    model's own values, carried over so a curator has something to correct
//    rather than invent. A human copies a line into golden, fixes the labels,
//    sets `expected_chunk`, and drops `provenance`; evals/run.py rejects a
//    line that still carries `provenance` so a raw paste fails loudly.
// 2. The output directory (evals/candidates/) is gitignored. The public
//    /r/<slug> form accepts text from anyone, so a candidate line can contain
//    a stranger's words; it must never reach the repo without a human
//    reading it first.
//
// `approve` actions are not exported (F13 names rejections and edits): an
// approved draft says nothing verified about the classification either.

export const EXPORTED_KINDS = ["edit", "reject"] as const;

export interface CandidateProvenance {
  action: "edit" | "reject";
  action_id: string;
  request_id: string;
  actor: string;
  at: string;
  /** The draft the staff member saw. */
  model_reply: string | null;
  /** edit: what they sent instead. reject: null. */
  human_reply: string | null;
  /** reject: the stated reason. edit: null. */
  reason: string | null;
}

export interface CandidateExample {
  id: string;
  subject: string;
  body: string;
  expected_category: string;
  expected_urgency: string;
  expected_chunk: null;
  provenance: CandidateProvenance;
}

interface ActionSnapshot {
  status?: string;
  replyText?: string | null;
  draftVersion?: number | null;
}

function snapshot(value: unknown): ActionSnapshot {
  return value && typeof value === "object" ? (value as ActionSnapshot) : {};
}

/**
 * Every edit/reject action in `orgId`, oldest first, as candidate examples.
 * Runs under forOrg() so RLS scopes it even though the query also filters
 * by org_id explicitly (AGENTS.md: every tenant query names org_id).
 *
 * The model's draft is not in the action snapshot - `before.replyText` is
 * the *request's* reply text (null until approved) and `before.draftVersion`
 * is the version the staff member was looking at. So the model draft is the
 * drafts row at that version, joined here. For an edit, `after.replyText` is
 * the human's text; for a reject, `reason` is the label-bearing field.
 */
export async function exportCandidates(db: Db, orgId: string): Promise<CandidateExample[]> {
  return forOrg(db, orgId, async (tx, scopedOrgId) => {
    const rows = await tx
      .select({
        actionId: actions.id,
        kind: actions.kind,
        actorEmail: actions.actorEmail,
        before: actions.before,
        after: actions.after,
        reason: actions.reason,
        createdAt: actions.createdAt,
        requestId: requests.id,
        subject: requests.subject,
        body: requests.body,
        category: requests.category,
        urgency: requests.urgency,
      })
      .from(actions)
      .innerJoin(
        requests,
        and(eq(requests.orgId, actions.orgId), eq(requests.id, actions.requestId)),
      )
      .where(and(eq(actions.orgId, scopedOrgId), inArray(actions.kind, [...EXPORTED_KINDS])))
      .orderBy(asc(actions.createdAt), asc(actions.id));

    // Model drafts for every (request, version) the snapshots point at.
    const draftRows = rows.length
      ? await tx
          .select({ requestId: drafts.requestId, version: drafts.version, body: drafts.body })
          .from(drafts)
          .where(
            and(
              eq(drafts.orgId, scopedOrgId),
              inArray(drafts.requestId, [...new Set(rows.map((r) => r.requestId))]),
            ),
          )
      : [];
    const draftBody = new Map(draftRows.map((d) => [`${d.requestId}:${d.version}`, d.body]));

    return rows.map((row) => {
      const kind = row.kind as "edit" | "reject";
      const before = snapshot(row.before);
      const modelReply =
        typeof before.draftVersion === "number"
          ? (draftBody.get(`${row.requestId}:${before.draftVersion}`) ?? null)
          : null;
      const humanReply = snapshot(row.after).replyText;
      return {
        id: `candidate-${row.actionId}`,
        subject: row.subject,
        body: row.body,
        // The model's values, not verified labels - see the header comment.
        expected_category: row.category ?? "other",
        expected_urgency: row.urgency ?? "normal",
        expected_chunk: null,
        provenance: {
          action: kind,
          action_id: row.actionId,
          request_id: row.requestId,
          actor: row.actorEmail,
          at: row.createdAt.toISOString(),
          model_reply: modelReply,
          human_reply: kind === "edit" && typeof humanReply === "string" ? humanReply : null,
          reason: kind === "reject" ? row.reason : null,
        },
      };
    });
  });
}

export function toJsonl(examples: CandidateExample[]): string {
  return examples.map((e) => JSON.stringify(e)).join("\n") + (examples.length ? "\n" : "");
}

function parseArgs(argv: string[]): { slug: string; outDir: string } {
  let slug: string | undefined;
  let outDir = join(fileURLToPath(new URL("../../evals/candidates/", import.meta.url)));
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--org") slug = argv[++i];
    else if (arg === "--out") outDir = argv[++i] ?? outDir;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!slug) throw new Error("usage: pnpm eval:export --org <slug> [--out <dir>]");
  return { slug, outDir };
}

// CLI only; eval-export.test.ts imports exportCandidates directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { slug, outDir } = parseArgs(process.argv.slice(2));
  // frontdesk_app, same audience reasoning as purge.ts: SELECT on orgs
  // plus row-scoped reads on actions/requests are all this needs.
  const url = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (or DATABASE_APP_URL locally) is required");
  const db = createDb(url);

  (async () => {
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, slug));
    if (!org) throw new Error(`no org with slug ${slug}`);
    const examples = await exportCandidates(db, org.id);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${slug}.jsonl`);
    writeFileSync(outPath, toJsonl(examples));
    logger.info("eval export: wrote candidates", {
      orgSlug: slug,
      count: examples.length,
      edits: examples.filter((e) => e.provenance.action === "edit").length,
      rejects: examples.filter((e) => e.provenance.action === "reject").length,
      outPath,
    });
  })()
    .catch((err: unknown) => {
      logger.error("eval export failed", { err: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}
