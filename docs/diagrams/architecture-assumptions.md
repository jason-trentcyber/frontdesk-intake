# Architecture diagram — assumptions & decisions

Peer document to `architecture.html` / `architecture.json` in this directory.
Publishing decisions (Pages, PNG-not-SVG, what is and isn't committed) are in
[ADR-0034](../adr/0034-architecture-diagram-published-to-github-pages.md); this
file records what the diagram *says* and why.

Nothing in the application was edited to produce it. It was generated from the
existing documentation with the `archify` CLI.

## What this is

A self-contained interactive diagram of frontdesk's **full system** — the
application (`web`, `api`, `worker`, Postgres), the edge (Cloudflare,
ingress-nginx), the delivery path (GitHub Actions, the migrate Job,
sealed-secrets) and off-node observability.

It supersedes an earlier application-only version (2026-09-12) that was authored
against ADRs 0001–0025 and had no auth in it.

## Source material

`REQUIREMENTS.md` and ADRs 0001–0033. Nothing is invented beyond what those
state; where a document was silent, the choice is recorded below.

## Scope

- **Full system.** The earlier revision deliberately excluded the edge, the
  chart and CI to keep the application legible on its own. That tradeoff was
  right when the application *was* the story. It no longer is: the delivery
  guardrails and the tenancy boundary are the point of this repository, and a
  reader who sees one box labelled "Postgres" learns nothing about them.
- **Switch-proof alternates shown.** Per ADR-0006 and ADR-0004, `LLM_PROVIDER`
  and `QUEUE_PROVIDER` each swap one adapter behind an unchanged interface.
  Bedrock and SQS are drawn as dashed edges tagged "switch-proof · not live"
  rather than omitted — that property is a first-class design decision
  (REQUIREMENTS §7), not an implementation detail.
- **One diagram**, not a set. No separate sequence diagram for the triage
  pipeline; the guided views carry that narrative instead.

## Modeling decisions where the docs required a judgment call

- **pgmq is part of the Postgres node, not a separate box.** ADR-0004:
  "`PostgresQueue` on the pgmq extension is the production adapter … Zero extra
  containers." A separate node would misrepresent it as a running service. The
  queues appear in edge labels instead ("enqueue via pgmq", "dequeue (pgmq)").
- **`db/` (`@frontdesk/db`) is not its own node.** It is an in-process
  TypeScript library compiled into `web` and `api`, not a runtime component
  (ADR-0018, ADR-0021). It appears as the `forOrg()` edge labels, with the
  worker's Python equivalent as `for_org()` (ADR-0023 §1).
- **`frontdesk-db-migrate` *is* its own node.** Unlike `db/`, it is a distinct
  Helm-hook Job with its own image that runs on every deploy and connects as the
  `frontdesk` owner role rather than `frontdesk_app` (ADR-0018). Dashed, because
  it is one-shot rather than a steady-state connection.
- **Auth appears as the Ingress path split, not as a separate service.**
  Auth.js runs inside `web`; ADR-0031 puts its tables in a dedicated `auth`
  schema in the same database. The `/api/auth` → `web` rule is drawn explicitly
  because routing it to `api` was a real production bug (26a follow-up, #26) and
  the one-line reason it exists is worth showing.
- **OAuth connects only to `web`.** Session and user tables live in the same
  Postgres (ADR-0003, ADR-0018), but that relationship is already covered by the
  `web → Postgres` edge. A second edge from the identity provider to the
  database would imply Google talks to Postgres directly. It does not.
- **`api → Postgres` is drawn once**, labelled as the enqueue. `api` also reads
  and writes tenant rows; splitting it into two edges added a label collision
  the layout could not clear, and the enqueue is the relationship a reader needs
  at this zoom level (ADR-0021: `api` is the sole queue producer).
- **Cloudflare is one node, not three.** DNS, TLS termination, the WAF managed
  ruleset, the burst-guard rate limit and the Turnstile widget are five distinct
  Terraform resources (`infra/cloudflare/main.tf`) but one hop in the request
  path. The detail lives in ADR-0002.
- **The tracking page and the read-only demo queue are not separate flows.**
  Both are served by `web` through `resolveTracking()` / normal `forOrg()` reads
  (ADR-0021) — already covered by the existing edges.

## Readability constraints that shaped the layout

`archify`'s showcase profile fails a diagram whose smallest text would project
below 6px at 1440×900. With 930px of reader width, that caps the `viewBox` at
about 1300 units — which is what forced these:

- Sublabels are short ("WAF · Turnstile", not "WAF · Turnstile · burst guard";
  "Python · asyncpg", not "Python · asyncpg + ONNX"). The renderer shrinks a
  sublabel to fit its node, so one long string can fail the whole artifact. The
  dropped detail is in the cards and the ADRs.
- Horizontal edge labels on the main row sit in a dedicated lane above the
  nodes. Adjacent columns are ~36px apart; no label fits between them.

## Verification performed

All three claims are separate, per `archify`'s delivery contract:

- `validate architecture … --quality showcase --json` — **9/9 artifact checks,
  0 composition errors, 0 warnings.** Metrics: 0 route crossings, 0 ambiguous
  corridors, 0 label/route clearance issues, max 2 bends per route.
- `deliver …` — passed, SHA-256 recorded for both spec and artifact.
- `visual-check … --json` — **pass** at 1440×900, 1600×1000, 1920×1080 and
  2048×1320 in both themes. Contained at every size
  (`scrollHeight == innerHeight`); minimum projected node text 7.50px at the
  smallest viewport, against a 6px floor.
- Perceptual review — performed on the rendered exports. One correction round:
  the `SealedSecret → Secret` and `migrate + seed` labels passed the 4px
  clearance rule but read as a single run-on string, and were staggered.

The earlier revision of this diagram never had browser evidence at all: its
`visual-check` could not launch (snap Chromium cannot expose a DevTools pipe).
Setting `ARCHIFY_CHROME` to a Playwright-managed Chromium fixes that — see
below. When that check finally ran against the old artifact it **failed**,
overflowing 1440×900, 1600×1000 and 1920×1080.

## Regenerating

From `~/.agents/skills/archify` on the VPS:

```bash
export ARCHIFY_CHROME=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
export ARCHIFY_CHROME_NO_SANDBOX=1
D=~/code/frontdesk-intake/docs/diagrams
node bin/archify.mjs validate     architecture $D/architecture.json --quality showcase --json
node bin/archify.mjs deliver      architecture $D/architecture.json $D/architecture.html --quality showcase --json
node bin/archify.mjs visual-check $D/architecture.html --json
```

Then re-export both PNGs (they are the viewer's own chrome-free export, not
screenshots — `visual-check` captures include the toolbar and are unsuitable for
the README). The export is a browser action, driven with Playwright:
`docs/diagrams/export-png.mjs`.

`visual-check` needs roughly 500 MB free to launch Chrome; on a loaded VPS it
fails with `Target.createTarget: timed out`, which is environmental and not a
defect in the artifact. Check `free -m` before believing a failure.
