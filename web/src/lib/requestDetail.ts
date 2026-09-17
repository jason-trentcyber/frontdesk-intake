import { actions, chunks, drafts, forOrg, requests, type Db } from "@frontdesk/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { RequestStatus } from "./staffQueue";

export interface RequestDetailDraft {
  id: string;
  version: number;
  body: string;
  citations: string[];
  confidence: string;
  model: string;
  createdAt: Date;
}

export interface RequestDetailAction {
  id: string;
  actorEmail: string;
  kind: "approve" | "edit" | "reject";
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: Date;
}

export interface CitationSnippet {
  chunkId: string;
  text: string;
}

export interface RequestDetailRequest {
  id: string;
  subject: string;
  body: string;
  requesterName: string | null;
  requesterEmail: string | null;
  status: RequestStatus;
  category: string | null;
  urgency: string | null;
  lane: string | null;
  summary: string | null;
  replyText: string | null;
  createdAt: Date;
}

export type RequestDetailView =
  | { kind: "not_found" }
  | {
      kind: "found";
      request: RequestDetailRequest;
      // Newest first. There is no is_winning column anywhere in this
      // schema (drafts is append-only, F12/ADR-0018) - the "current"
      // draft is defined here as the highest version, which is also
      // exactly what an edit-then-approve produces (26b decision #1, see
      // the PR body): editing always authors version N+1, so the latest
      // version is never anything other than what staff most recently
      // considered current.
      drafts: RequestDetailDraft[];
      latestDraft: RequestDetailDraft | null;
      // Resolved snippets for latestDraft's citations only - citations on
      // older, superseded draft versions are not expanded (nothing in the
      // UI shows them, so nothing resolves them).
      citations: CitationSnippet[];
      // Newest first (F12: "who, when, before/after" - the full audit
      // trail for this request, not just the latest action).
      actionHistory: RequestDetailAction[];
    };

function parseCitations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * F11: request detail (original text, classification, draft, expandable
 * citations, confidence) plus F12's action history. Everything after the
 * initial request lookup runs inside the same forOrg() transaction
 * (ADR-0018 "belt and braces") - the explicit org_id predicate stays on
 * every select even though RLS already scopes it.
 */
export async function getRequestDetail(
  db: Db,
  orgId: string,
  requestId: string,
): Promise<RequestDetailView> {
  return forOrg(db, orgId, async (tx, scopedOrgId) => {
    const [requestRow] = await tx
      .select({
        id: requests.id,
        subject: requests.subject,
        body: requests.body,
        requesterName: requests.requesterName,
        requesterEmail: requests.requesterEmail,
        status: requests.status,
        category: requests.category,
        urgency: requests.urgency,
        lane: requests.lane,
        summary: requests.summary,
        replyText: requests.replyText,
        createdAt: requests.createdAt,
      })
      .from(requests)
      .where(and(eq(requests.orgId, scopedOrgId), eq(requests.id, requestId)));

    if (!requestRow) {
      return { kind: "not_found" };
    }

    const draftRows = await tx
      .select({
        id: drafts.id,
        version: drafts.version,
        body: drafts.body,
        citations: drafts.citations,
        confidence: drafts.confidence,
        model: drafts.model,
        createdAt: drafts.createdAt,
      })
      .from(drafts)
      .where(and(eq(drafts.orgId, scopedOrgId), eq(drafts.requestId, requestId)))
      .orderBy(desc(drafts.version));

    const draftList: RequestDetailDraft[] = draftRows.map((d) => ({
      id: d.id,
      version: d.version,
      body: d.body,
      citations: parseCitations(d.citations),
      confidence: d.confidence,
      model: d.model,
      createdAt: d.createdAt,
    }));
    const latestDraft = draftList[0] ?? null;

    let citationSnippets: CitationSnippet[] = [];
    if (latestDraft && latestDraft.citations.length > 0) {
      const chunkRows = await tx
        .select({ id: chunks.id, text: chunks.text })
        .from(chunks)
        .where(and(eq(chunks.orgId, scopedOrgId), inArray(chunks.id, latestDraft.citations)));
      const byId = new Map(chunkRows.map((c) => [c.id, c.text]));
      // Preserve citation order as they appear in the draft, not
      // whatever order the IN() lookup returns rows in.
      citationSnippets = latestDraft.citations
        .filter((id) => byId.has(id))
        .map((id) => ({ chunkId: id, text: byId.get(id)! }));
    }

    const actionRows = await tx
      .select({
        id: actions.id,
        actorEmail: actions.actorEmail,
        kind: actions.kind,
        before: actions.before,
        after: actions.after,
        reason: actions.reason,
        createdAt: actions.createdAt,
      })
      .from(actions)
      .where(and(eq(actions.orgId, scopedOrgId), eq(actions.requestId, requestId)))
      .orderBy(desc(actions.createdAt));

    return {
      kind: "found",
      request: requestRow,
      drafts: draftList,
      latestDraft,
      citations: citationSnippets,
      actionHistory: actionRows,
    };
  });
}
