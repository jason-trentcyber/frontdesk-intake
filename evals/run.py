"""The deterministic eval gate (ADR-0036; REQUIREMENTS S4; ADR-0008 step 4).

    make eval                      # replay fixtures, compare to baseline, exit 1 on regression
    make eval ARGS="--record"      # human-run: call the real provider, rewrite fixtures
    make eval ARGS="--no-gate"     # report only (first run, before a baseline exists)

Runs `evals/golden/*.jsonl` through the shipped pipeline - the real chunker
and ONNX embedder (`frontdesk_worker.ingestion`), the real classifier
(`frontdesk_worker.triage.classify`), the real hybrid retrieval
(`frontdesk_worker.triage.retrieve`) - against `db/seed/bright-smile-dental/`
ingested into a throwaway org that is created and deleted inside this run.
Nothing is mocked except the LLM, which is replayed from
`evals/fixtures/completions.json` (see recorded.py) so CI spends nothing.

Metrics, all deterministic, all compared to `evals/baseline.json` with zero
tolerance (any drop fails):

- classification_accuracy - exact match on `expected_category`.
- recall_at_5 - an expected chunk is in the top-5 (the metric S4 names).
- recall_at_1 - the expected chunk is ranked first. Added because the seed
  corpus is four one-chunk documents, so top-5 over four candidates can only
  miss below the similarity floor; rank-1 is what actually moves when RRF,
  chunking, or the embedder change.

Reported, never gated: urgency accuracy (label noise on a 3-way ordinal).

Env: DATABASE_URL (owner role - creates/deletes the eval org and its
documents, same reasoning as worker/tests/conftest.py), DATABASE_APP_URL
(frontdesk_app - ingestion and retrieval go through for_org() exactly as
production does). `--record` additionally needs LLM_PROVIDER (a real one)
and its credential, read by llm.get_provider() - never by this file.
"""

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import asyncpg

from evals.recorded import RecordedProvider, RecordingProvider, UnrecordedPrompt
from frontdesk_worker.db import for_org
from frontdesk_worker.ingestion.embedder import Embedder, ModelNotFetched
from frontdesk_worker.ingestion.pipeline import run_ingestion_pipeline
from frontdesk_worker.triage.classify import classify_and_route
from frontdesk_worker.triage.retrieve import retrieve_chunks
from llm import KNOWN_PROVIDERS, LLMProvider, get_provider

EVALS_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVALS_DIR.parent
GOLDEN_DIR = EVALS_DIR / "golden"
FIXTURES_PATH = EVALS_DIR / "fixtures" / "completions.json"
BASELINE_PATH = EVALS_DIR / "baseline.json"
SEED_DIR = REPO_ROOT / "db" / "seed" / "bright-smile-dental"

# The demo org's settings - categories, lanes and the per-category
# descriptions the classify prompt renders (#152) - read from the same
# file db/src/seed.ts seeds it from, so the gate scores the shipped
# configuration and cannot drift from it. The golden set is validated
# against CATEGORIES at load time, so a label the org does not configure is
# a loud failure here, not a silent 0% accuracy.
SETTINGS_PATH = SEED_DIR / "settings.json"
_SETTINGS: dict[str, object] = json.loads(SETTINGS_PATH.read_text())
CATEGORIES: list[str] = list(_SETTINGS["categories"])  # type: ignore[arg-type]
LANES: dict[str, str] = dict(_SETTINGS["lanes"])  # type: ignore[arg-type]
CATEGORY_DESCRIPTIONS: dict[str, str] = dict(_SETTINGS.get("categoryDescriptions", {}))  # type: ignore[arg-type]
URGENCIES = {"low", "normal", "high"}

GATED_METRICS = ("classification_accuracy", "recall_at_5", "recall_at_1")
# baseline.json is written and compared at this precision, so 16/18 does
# not read as "below" a baseline of 0.8889.
BASELINE_DECIMALS = 4
REPORTED_METRICS = ("urgency_accuracy",)

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_ANCHOR_RE = re.compile(r"^([a-z0-9-]+\.md)#(.+)$")
_GOLDEN_KEYS = frozenset(
    {"id", "subject", "body", "expected_category", "expected_urgency", "expected_chunk"}
)


class HarnessError(Exception):
    """A problem with the harness or its inputs - not a metric regression.
    Exit code 2 so CI can tell the two apart."""


@dataclass(frozen=True)
class Example:
    id: str
    subject: str
    body: str
    expected_category: str
    expected_urgency: str
    expected_chunk: str | None  # "<file>.md#<Heading>" or None (excluded from recall)


@dataclass
class Result:
    id: str
    category: str
    urgency: str
    expected_category: str
    expected_urgency: str
    expected_chunk: str | None
    top_ids: list[str] = field(default_factory=list)
    expected_ids: frozenset[str] = frozenset()

    @property
    def category_ok(self) -> bool:
        return self.category == self.expected_category

    @property
    def urgency_ok(self) -> bool:
        return self.urgency == self.expected_urgency

    @property
    def in_recall(self) -> bool:
        return self.expected_chunk is not None

    @property
    def hit_at_5(self) -> bool:
        return any(i in self.expected_ids for i in self.top_ids[:5])

    @property
    def hit_at_1(self) -> bool:
        return bool(self.top_ids) and self.top_ids[0] in self.expected_ids


# --- golden set ---------------------------------------------------------------


def load_golden(golden_dir: Path) -> list[Example]:
    files = sorted(golden_dir.glob("*.jsonl"))
    if not files:
        raise HarnessError(f"no *.jsonl under {golden_dir}")
    examples: list[Example] = []
    seen: set[str] = set()
    for path in files:
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            where = f"{path.name}:{lineno}"
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as exc:
                raise HarnessError(f"{where}: invalid JSON ({exc})") from exc
            unknown = set(raw) - _GOLDEN_KEYS
            if unknown:
                # A candidate line from `pnpm eval:export` still carries its
                # `provenance` block (and the model's unverified labels). It
                # must be curated, not pasted - fail loudly rather than score it.
                raise HarnessError(
                    f"{where}: unexpected keys {sorted(unknown)} - if this came from "
                    "evals/candidates/, curate the labels and drop `provenance` first"
                )
            for key in ("id", "subject", "body", "expected_category", "expected_urgency"):
                if not isinstance(raw.get(key), str) or not raw[key].strip():
                    raise HarnessError(f"{where}: {key!r} missing or empty")
            if raw["id"] in seen:
                raise HarnessError(f"{where}: duplicate id {raw['id']!r}")
            seen.add(raw["id"])
            if raw["expected_category"] not in CATEGORIES:
                raise HarnessError(
                    f"{where}: expected_category {raw['expected_category']!r} not in {CATEGORIES}"
                )
            if raw["expected_urgency"] not in URGENCIES:
                raise HarnessError(f"{where}: expected_urgency must be one of {sorted(URGENCIES)}")
            chunk = raw.get("expected_chunk")
            if chunk is not None and not (isinstance(chunk, str) and _ANCHOR_RE.match(chunk)):
                raise HarnessError(
                    f"{where}: expected_chunk must be '<file>.md#<Heading>' or null, got {chunk!r}"
                )
            examples.append(
                Example(
                    id=raw["id"],
                    subject=raw["subject"],
                    body=raw["body"],
                    expected_category=raw["expected_category"],
                    expected_urgency=raw["expected_urgency"],
                    expected_chunk=chunk,
                )
            )
    return examples


# --- seed corpus + anchor resolution ------------------------------------------


def section_first_blocks(markdown: str) -> dict[str, str]:
    """heading text -> the first paragraph under it, using the same block
    rules as ingestion/chunker.py (blank-line separated, headings are not
    blocks). The chunker carries only each chunk's *first* block's heading
    into the chunk text, so a heading line is not a reliable anchor; the
    first paragraph of the section is - overlap carries whole blocks, so a
    chunk that covers the section contains that paragraph verbatim."""
    sections: dict[str, str] = {}
    current: str | None = None
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf
        text = "\n".join(buf).strip()
        if current is not None and text and current not in sections:
            sections[current] = text
        buf = []

    for line in markdown.splitlines():
        m = _HEADING_RE.match(line)
        if m:
            flush()
            current = m.group(2).strip()
            continue
        if line.strip() == "":
            flush()
            continue
        buf.append(line)
    flush()
    return sections


def _parse_anchor(anchor: str) -> tuple[str, str]:
    m = _ANCHOR_RE.match(anchor)
    assert m is not None  # validated in load_golden
    return m.group(1), m.group(2)


async def ingest_corpus(
    owner: asyncpg.Connection, app_pool: asyncpg.Pool, embedder: Embedder, org_id: str
) -> dict[str, str]:
    """Insert the seed docs as the owner role (as db/src/seed.ts does), then
    ingest each through the real pipeline under for_org(). Returns
    filename -> document id."""
    doc_ids: dict[str, str] = {}
    for path in sorted(SEED_DIR.glob("*.md")):
        raw = path.read_bytes()
        row = await owner.fetchrow(
            "insert into documents (org_id, title, filename, mime, sha256, raw, status) "
            "values ($1, $2, $3, 'text/markdown', $4, $5, 'pending') returning id",
            org_id,
            path.stem,
            path.name,
            hashlib.sha256(raw).hexdigest(),
            raw,
        )
        assert row is not None
        doc_ids[path.name] = str(row["id"])
    if not doc_ids:
        raise HarnessError(f"no *.md under {SEED_DIR}")
    async with for_org(app_pool, org_id) as conn:
        for doc_id in doc_ids.values():
            await run_ingestion_pipeline(conn, embedder, org_id, doc_id)
        failed = await conn.fetch(
            "select filename, error from documents where org_id = $1 and status <> 'indexed'",
            org_id,
        )
    if failed:
        raise HarnessError(
            "ingestion failed: " + ", ".join(f"{r['filename']}: {r['error']}" for r in failed)
        )
    return doc_ids


async def resolve_anchors(
    owner: asyncpg.Connection, org_id: str, doc_ids: dict[str, str], examples: list[Example]
) -> dict[str, frozenset[str]]:
    """anchor -> chunk ids that cover it. Every anchor must resolve to at
    least one chunk, otherwise the label is wrong (typo, renamed heading)
    and the run stops rather than scoring it as a miss."""
    chunks_by_doc: dict[str, list[tuple[str, str]]] = {}
    rows = await owner.fetch("select id, document_id, text from chunks where org_id = $1", org_id)
    for r in rows:
        chunks_by_doc.setdefault(str(r["document_id"]), []).append((str(r["id"]), r["text"]))

    sections_by_file = {
        name: section_first_blocks((SEED_DIR / name).read_text()) for name in doc_ids
    }

    resolved: dict[str, frozenset[str]] = {}
    problems: list[str] = []
    for ex in examples:
        if ex.expected_chunk is None or ex.expected_chunk in resolved:
            continue
        filename, heading = _parse_anchor(ex.expected_chunk)
        if filename not in doc_ids:
            problems.append(f"{ex.id}: no seed document {filename!r}")
            continue
        first_block = sections_by_file[filename].get(heading)
        if first_block is None:
            problems.append(f"{ex.id}: no heading {heading!r} in {filename}")
            continue
        ids = frozenset(
            cid for cid, text in chunks_by_doc.get(doc_ids[filename], []) if first_block in text
        )
        if not ids:
            problems.append(f"{ex.id}: no chunk of {filename} contains the {heading!r} section")
            continue
        resolved[ex.expected_chunk] = ids
    if problems:
        raise HarnessError("unresolvable expected_chunk anchors:\n  " + "\n  ".join(problems))
    return resolved


# --- scoring -------------------------------------------------------------------


async def evaluate(
    app_pool: asyncpg.Pool,
    embedder: Embedder,
    provider: LLMProvider,
    org_id: str,
    examples: list[Example],
    anchors: dict[str, frozenset[str]],
) -> list[Result]:
    results: list[Result] = []
    async with for_org(app_pool, org_id) as conn:
        for ex in examples:
            classification = await classify_and_route(
                provider,
                CATEGORIES,
                LANES,
                ex.subject,
                ex.body,
                category_descriptions=CATEGORY_DESCRIPTIONS,
            )
            query_text = f"{ex.subject}\n\n{ex.body}"
            vector = embedder.embed_batch([query_text])[0]
            retrieved = await retrieve_chunks(conn, org_id, vector, query_text)
            results.append(
                Result(
                    id=ex.id,
                    category=classification.category,
                    urgency=classification.urgency,
                    expected_category=ex.expected_category,
                    expected_urgency=ex.expected_urgency,
                    expected_chunk=ex.expected_chunk,
                    top_ids=[c.id for c in retrieved],
                    expected_ids=anchors.get(ex.expected_chunk or "", frozenset()),
                )
            )
    return results


def metrics_of(results: list[Result]) -> dict[str, float]:
    n = len(results)
    recall_pool = [r for r in results if r.in_recall]
    m = len(recall_pool)
    raw = {
        "classification_accuracy": sum(r.category_ok for r in results) / n,
        "recall_at_5": sum(r.hit_at_5 for r in recall_pool) / m,
        "recall_at_1": sum(r.hit_at_1 for r in recall_pool) / m,
        "urgency_accuracy": sum(r.urgency_ok for r in results) / n,
    }
    return {k: round(v, BASELINE_DECIMALS) for k, v in raw.items()}


def load_baseline(path: Path) -> dict[str, float] | None:
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    missing = [k for k in GATED_METRICS if k not in data]
    if missing:
        raise HarnessError(f"{path} is missing gated metrics: {missing}")
    return {k: float(v) for k, v in data.items() if k in GATED_METRICS}


def print_report(
    results: list[Result], metrics: dict[str, float], baseline: dict[str, float] | None
) -> list[str]:
    """Prints the per-example misses and the metric table; returns the
    names of gated metrics that fell below baseline."""
    misses = [r for r in results if not r.category_ok or (r.in_recall and not r.hit_at_1)]
    if misses:
        print("misses:")
        for r in misses:
            notes = []
            if not r.category_ok:
                notes.append(f"category {r.category!r} != {r.expected_category!r}")
            if r.in_recall and not r.hit_at_5:
                notes.append("expected chunk not in top-5")
            elif r.in_recall and not r.hit_at_1:
                rank = next(
                    (i + 1 for i, cid in enumerate(r.top_ids) if cid in r.expected_ids), None
                )
                notes.append(f"expected chunk ranked #{rank}, not #1")
            print(f"  {r.id}: " + "; ".join(notes))
        print()

    regressions: list[str] = []
    print(f"{'metric':<26} {'value':>7} {'baseline':>9}  status")
    for name in GATED_METRICS + REPORTED_METRICS:
        value = metrics[name]
        if name in REPORTED_METRICS:
            print(f"{name:<26} {value:>7.3f} {'-':>9}  reported only")
            continue
        if baseline is None:
            print(f"{name:<26} {value:>7.3f} {'(none)':>9}  no baseline")
            continue
        floor = baseline[name]
        ok = value >= floor
        if not ok:
            regressions.append(name)
        print(f"{name:<26} {value:>7.3f} {floor:>9.3f}  {'ok' if ok else 'REGRESSION'}")
    return regressions


# --- entry ---------------------------------------------------------------------


def _make_provider(record: bool) -> tuple[LLMProvider, RecordingProvider | None]:
    """(provider to call, recorder to flush afterwards or None)."""
    if not record:
        replay = RecordedProvider(FIXTURES_PATH)
        if replay.size == 0:
            raise HarnessError(f"{FIXTURES_PATH} is empty or missing; run with --record first")
        return replay, None
    name = os.environ.get("LLM_PROVIDER")
    if name not in KNOWN_PROVIDERS or name == "fake":
        raise HarnessError(
            "--record needs LLM_PROVIDER set to a real provider (it spends tokens on purpose)"
        )
    inner = get_provider(name, model_alias=os.environ.get("LLM_MODEL", "haiku"))
    recorder = RecordingProvider(inner, FIXTURES_PATH)
    return recorder, recorder


async def main_async(args: argparse.Namespace) -> int:
    owner_dsn = os.environ.get("DATABASE_URL")
    app_dsn = os.environ.get("DATABASE_APP_URL")
    if not owner_dsn or not app_dsn:
        raise HarnessError("DATABASE_URL and DATABASE_APP_URL are required")

    examples = load_golden(GOLDEN_DIR)
    provider, recorder = _make_provider(args.record)
    try:
        embedder = Embedder()
    except ModelNotFetched as exc:
        raise HarnessError(str(exc)) from exc
    baseline = None if args.no_gate else load_baseline(BASELINE_PATH)
    if baseline is None and not args.no_gate:
        raise HarnessError(f"{BASELINE_PATH} does not exist; pass --no-gate for a report-only run")

    owner = await asyncpg.connect(dsn=owner_dsn)
    app_pool = await asyncpg.create_pool(dsn=app_dsn, min_size=1, max_size=2)
    assert app_pool is not None
    org_id: str | None = None
    try:
        slug = f"eval-{uuid.uuid4().hex[:12]}"
        row = await owner.fetchrow(
            "insert into orgs (slug, name, daily_token_budget, settings) "
            "values ($1, $1, 1000000, $2::jsonb) returning id",
            slug,
            json.dumps(_SETTINGS),
        )
        assert row is not None
        org_id = str(row["id"])

        doc_ids = await ingest_corpus(owner, app_pool, embedder, org_id)
        anchors = await resolve_anchors(owner, org_id, doc_ids, examples)
        try:
            results = await evaluate(app_pool, embedder, provider, org_id, examples, anchors)
        except UnrecordedPrompt as exc:
            raise HarnessError(str(exc)) from exc
    finally:
        if org_id is not None:
            # chunks cascade off documents; the eval org never has requests.
            await owner.execute("delete from documents where org_id = $1", org_id)
            await owner.execute("delete from orgs where id = $1", org_id)
        await app_pool.close()
        await owner.close()

    if recorder is not None:
        recorder.flush()
        print(
            f"recorded {recorder.calls} completions to {FIXTURES_PATH.relative_to(REPO_ROOT)} "
            f"(cost ${recorder.cost_usd:.4f})\n"
        )

    metrics = metrics_of(results)
    print(
        f"golden: {len(examples)} examples, {sum(e.expected_chunk is not None for e in examples)} with a retrieval anchor\n"
    )
    regressions = print_report(results, metrics, baseline)

    if args.json:
        print()
        print(json.dumps({k: v for k, v in metrics.items()}, indent=2))
    if baseline is None:
        print(
            f"\nno gate applied. To set the baseline, a human commits {BASELINE_PATH.relative_to(REPO_ROOT)}:"
        )
        print(json.dumps({k: metrics[k] for k in GATED_METRICS}, indent=2))
        return 0
    if regressions:
        print(f"\nFAIL: {', '.join(regressions)} below baseline (zero tolerance)")
        return 1
    print("\nPASS: no gated metric below baseline")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--record",
        action="store_true",
        help="call the real LLM_PROVIDER and rewrite fixtures (human-run)",
    )
    parser.add_argument(
        "--no-gate", action="store_true", help="report metrics without comparing to baseline"
    )
    parser.add_argument("--json", action="store_true", help="also print metrics as JSON")
    args = parser.parse_args()
    try:
        return asyncio.run(main_async(args))
    except HarnessError as exc:
        print(f"eval harness error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
