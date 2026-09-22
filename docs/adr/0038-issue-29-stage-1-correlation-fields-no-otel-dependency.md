# ADR-0038: #29 splits; stage 1 is correlation fields in the logs both services already write, with no OTel dependency

Status: decided 2026-09-21 (#29). Narrows #29. Amends nothing. §1's stage table corrected by ADR-0039: stage 2 splits into 2a (collector → Loki pipeline, no app code) and 2b (OTel SDK), and the collector was never blocked on #52 — #52's Loki was blocked on the collector having something to ship.

## Context

Issue #29 ("[B38] Observability: OTel in all services, org_id/request_id on every span and log, dashboards") asks for four things at once: an OTel SDK in web/api/worker, a collector, structured logs carrying `org_id` and `request_id`, and Grafana dashboards with alerts. Its acceptance criterion is "one request's trace spans api → queue → worker → LLM; dashboards populated; one alert fires in a test and shows in Alertmanager."

Three facts make that one issue unshippable as a unit.

**The dashboards half is already constrained by a decided ADR.** ADR-0026 shipped Prometheus + Grafana on the VPS and *deferred Loki and Alertmanager on measured memory*. "Dashboards populated" and "an alert shows in Alertmanager" therefore depend on a component that a previous decision deliberately did not deploy. That is a node-capacity question (#52), not a code question, and it cannot be resolved inside this issue.

**The logging premise was false, in different ways in each service.** `docs/conventions.md` requires "structured JSON logs everywhere with `org_id` and `request_id` when available." Before this work:

- `worker/` called `logging.basicConfig(format='{"level": "%(levelname)s", "msg": %(message)r}')`. `%(message)r` is Python's `repr()`, which single-quotes — so an ordinary worker log line was *not valid JSON at all*, and would have been dropped by any JSON log pipeline. The format string also referenced no `extra=` fields, so the `org_id`/`request_id`/`msg_id` that `consumer.py` has always passed on all six of its log calls were silently discarded. Both halves of the convention were false.
- `api/` was better: Fastify's `logger: true` emits real JSON via pino. But its `reqId` is a per-process counter (`req-1`, `req-2`, …; `fastify/lib/req-id-gen-factory.js`), which restarts at 1 on every pod restart and repeats across replicas. Two unrelated requests in one stream are indistinguishable — the one thing a correlation id exists to prevent.

Adding an OTel SDK on top of that would have produced traces next to logs that still could not be joined to them.

**Nothing downstream can consume traces yet.** There is no collector on the node and, per ADR-0026, no log aggregator. An OTel SDK added today exports to nothing; the dependency and its startup cost would be carried by every service for a capability no one can query until #52 resolves.

## Decision

**#29 ships in three stages. This ADR decides stage 1 and scopes the other two; each later stage gets its own ADR when its blocker clears.**

### 1. Stage boundaries

| Stage | Contents | Blocked on |
|---|---|---|
| 1 (this ADR, now) | Correlation fields in the logs both services already write. No SDK, no new dependency, no collector. | nothing |
| 2 | OTel SDK + collector; `trace_id`/`span_id` join the same log objects; spans across api → queue → worker → LLM. | a collector on the node, i.e. #52's memory verdict |
| 3 | Log aggregation and dashboards/alerts. | ADR-0026's deferred Loki/Alertmanager trigger (#52) |

Stage 1 is worth shipping alone because the correlation fields are what make stages 2 and 3 *queryable*. They are also what `docs/conventions.md` already required and did not have.

### 2. No new dependency in stage 1

Stage 1 adds no package to `worker/requirements*.txt` or any `package.json`. The worker gets a ~120-line `JsonFormatter` (`worker/frontdesk_worker/logging_config.py`); api reuses the pino instance Fastify already constructs. `trace_id`/`span_id` are stage 2's, and when they arrive they arrive as two more keys in the same object — no call site changes.

The formatter merges whatever a caller passes in `extra=` rather than naming fields explicitly. Naming them explicitly is precisely how the old format string came to discard every one of them: a format string that must be edited whenever a call site adds context eventually stops being edited.

### 3. `api/` mints a UUID per request, and validates any inbound id itself

`genReqId` (`api/src/logging.ts`) honours an inbound `x-request-id` when it passes `sanitizeRequestId`, and generates a UUID otherwise, so an id set at the edge survives into our logs.

**`requestIdHeader` is deliberately left unset**, and this is the trap worth recording. It reads like the option for "honour an inbound header," but Fastify implements it as `req.headers[requestIdHeader] || genReqId(req)` (`lib/req-id-gen-factory.js:46-49`): the **raw** header value wins and `genReqId` degrades to a fallback, so `sanitizeRequestId` would never run on the one input an attacker controls. The intake path is reachable unauthenticated (Turnstile only), so that value is attacker-controlled. Left at its default (`false`), `genReqId` runs for every request and does its own header read and validation. `api/src/logging.test.ts` asserts the vulnerable behaviour explicitly against a bare Fastify, so re-adding the option contradicts a test instead of silently widening the hole.

Validation is an allow-list (`/^[A-Za-z0-9_.:-]+$/`, 128 chars), not a control-character denylist: the id is read by grep, by a human in a terminal, and later by a log parser, and an id that is safe only because one specific serializer escapes it is a latent problem for the next consumer. A failing id is replaced silently — rejecting a request over a log field would turn an observability nicety into an availability risk.

### 4. Correlation crosses the queue on the requests-row id, not on the HTTP id, and one bridge log line joins them

The queue contract (`api/src/queue/index.ts`) carries `{orgId, requestId}` and rejects unknown keys, in both languages. Stage 1 **does not extend it**. Propagating the HTTP id would mean a schema change, a cross-language contract change, and a migration of in-flight messages, to carry a second id when a perfectly good shared one already crosses the hop: `requestId`, the `requests` row UUID, which api generates and the worker logs on every line.

The seam is that `reqId` (HTTP hop) and `request_id` (requests row) are different identifiers, and exactly one record has to contain both. `api/src/routes/requests.ts` logs it immediately after a successful enqueue, with `org_id`/`request_id` in snake_case to match the worker's key names, so one query over a merged stream matches both services. That single line is what makes "follow one request from api into worker" possible without touching the queue contract.

**Naming, so this is not re-litigated:** `reqId` is per HTTP hop; `request_id` is the tenant-scoped row the whole pipeline is about. They are not the same thing and must not be merged into one field. Stage 2's `trace_id` becomes the third, and is the one that spans both.

### 5. Not done in stage 1

- **`web/`** keeps `db/src/logger.ts` as-is. Next.js server actions are a different request model (no Fastify hook to hang an id on) and F12's staff actions are not the path #29's acceptance criterion follows. It joins in stage 2 with the SDK.
- **A `logger.ts`/`logging_config.py` shared package.** Two files, ~200 lines total, in two languages. A shared abstraction over them would be more code than they are.
- **Sampling, log levels per module, redaction config.** No volume problem exists yet on a single node.

## Consequences

- Worker log lines are valid JSON for the first time, and carry `msg_id`, `org_id`, `request_id`, `delivery_attempt` on every `consumer.py` call site without those call sites changing — the `extra=` they always passed now arrives.
- `worker/tests/test_logging_config.py` fails against the old `basicConfig` format string (verified by mutation: it is a `json.loads` assertion on an ordinary, apostrophe-free message, which the old format rendered with single quotes). `api/src/logging.test.ts` fails if `genReqId` is removed from `buildApp`, asserting the id is a UUID and does not match `/^req-/`.
- api emits one extra log line per accepted intake request. At the current volume that is not a cost; it is also the line with the highest diagnostic value in the service.
- `docs/conventions.md` line 62 becomes true for `api/` and `worker/`. It remains aspirational for `web/` until stage 2.
- The eval gate (ADR-0036) and the queue contract (ADR-0004, ADR-0023, ADR-0025) are untouched: no prompt, no message shape, and no database query changes here.
- #29 cannot be closed by this work. It stays open against stages 2 and 3, both gated on #52's memory verdict for the node.

## Alternatives rejected

- **Ship all of #29 at once.** Requires a collector and a log aggregator that ADR-0026 deliberately did not deploy on a 4 GB node. The code half would sit unverifiable behind the infrastructure half for as long as #52 takes.
- **Add the OTel SDK now, export to nothing.** A dependency in three services, plus startup cost, for a capability nothing can query yet. Stage 1 delivers the fields that make traces joinable; the SDK is worth adding when there is something to receive it.
- **Put the HTTP request id into the `TriageMessage` contract.** A cross-language JSON-Schema change and an in-flight-message migration to carry a second identifier across a hop that already carries a shared one. One log line at the seam achieves the join with no contract change.
- **Set `requestIdHeader: 'x-request-id'` and drop the custom generator.** Hands an unvalidated, attacker-controlled, 128-byte-plus value straight into every log line for that request. See §3.
- **Keep pino's `req-N` counter and correlate on `request_id` alone.** Works only for requests that reach a successful enqueue. Every rejected request — bad API key, failed Turnstile, unknown org, validation failure — has no row and no id, and those are the ones worth investigating.
