# ADR-0040: The ops loop is a scheduled Hermes job reading Prometheus alerts directly; Alertmanager stays out

Status: decided 2026-09-22 (#32, #52, #29 stage 3). Supersedes ADR-0026's Alertmanager deferral trigger and #52's "one test alert fires to Alertmanager" wording. Amends nothing else.

## Context

REQUIREMENTS S6 and `docs/AI-GOVERNANCE.md` specify the sixth SDLC guardrail: a scheduled agent with read-only cluster and log access reviews alerts and error logs, files GitHub issues with evidence and a proposed fix, and never applies changes. The README has said "specified, not built" against it since 2026-09-07. It was the last README claim about the SDLC that was false.

Everything it reads from now exists. #29 stage 1 (ADR-0038) made every `api/` and `worker/` log line valid JSON with `org_id`/`request_id`; stage 2a (ADR-0039) ships every pod's stdout to Loki on the VPS. Prometheus has scraped the node since ADR-0026. What did not exist, measured on 2026-09-22 before writing this:

- **No alert rules.** `GET /api/v1/rules` on the VPS's Prometheus returned `{"groups": []}`. ADR-0026 deferred Alertmanager on "an alert rule exists that someone would act on"; nobody had written one, because nothing consumed one.
- **No read-only cluster identity.** The only ServiceAccount with a kubeconfig outside the cluster is `deployer` (ADR-0014), which can create and delete in `frontdesk`. AI-GOVERNANCE's "Read cluster state, logs, alerts: read-only SA" row named an identity that had never been minted.
- **Real findings to file.** In the 24 h before this ADR, one signal was in Loki and the cluster that a human had not looked at: the nightly `frontdesk-db-backup` Job's first attempt fails with `connection refused` at 03:15:00 UTC every night and its retry succeeds at 03:15:01 (`restarts=1`, `.dump` written). That is ADR-0016's backup window doing what it said, but it is exactly the shape of thing the ops loop must learn to *not* file - which means the loop needs a written noise list from day one.

## Decision

### 1. Alertmanager is not deployed; the ops agent reads `/api/v1/alerts` from Prometheus

Alertmanager's job is to route notifications to humans - dedupe, group, silence, page. The consumer here is a scheduled agent that already polls on its own cadence and does its own dedupe against open issues. Prometheus evaluates `rule_files` and exposes the resulting state at `/api/v1/alerts` (`pending`/`firing`, labels, annotations, `activeAt`) with no Alertmanager configured. Running a router with no receiver is the ceremony ADR-0026 rejected, and a fourth container on the VPS for a feature the agent does not use.

**This changes #52's last acceptance line.** "One test alert fires to Alertmanager" becomes "one alert rule fires and is observed by the ops agent", and is checkable: set a rule's threshold to a value the node currently exceeds, run the collector, see it under `[FIRING]`, put it back. ADR-0026's third trigger - an alert rule someone would act on - is now met by the rules in §2; the *deferral* it gated is closed by this decision rather than by deploying the thing it deferred. If a human ever needs to be paged rather than issued-at, Alertmanager is the natural add and this section is what a new ADR supersedes.

### 2. Four node-level rules, sized for a 6-hourly reader

`deploy/observability/prometheus/rules/node.yaml`, loaded via `rule_files` and a read-only bind mount in `compose.yaml`:

| alert | expr | for | why this threshold |
|---|---|---|---|
| `NodeExporterDown` | `up{job="node-exporter"} == 0` | 10m | every other rule is blind without it; first thing to check |
| `NodeMemoryAvailableLow` | available/total < 15% | 30m | 4 GB node; the next pod roll is what OOM-kills something |
| `NodeRootFilesystemLow` | avail/size on `/` < 15% | 1h | 40 GB disk holds Postgres, the 14-day backups PVC and images; 15% ≈ 6 GB ≈ two weeks at current backup size |
| `NodeLoadHigh` | `node_load15 > 8` | 30m | 4 vCPU; sustained 2× cores is a spin, the pipeline is bursty by design |

`for` windows are minutes, not seconds, because "firing" means "visible to a reader that comes every 6 h" - a 30-second blip that clears itself is not something the loop should file. Only node-exporter is scraped (ADR-0026 §2), so every rule is a node fact; per-pod rules arrive with the cadvisor follow-up ADR-0026 named. Validated with `promtool check rules` on the pinned image (`prom/prometheus:v3.7.3`), which CI does not run - the recipe is in the rules file header.

### 3. A cluster-wide read-only ServiceAccount, narrower than `view`

`deploy/bootstrap/rbac/ops-reader.yaml`: ServiceAccount `ops-reader` in `frontdesk`, bound to a ClusterRole granting `get/list/watch` on pods, `pods/log`, events, nodes, namespaces, PVCs, the `apps` workload kinds, `batch` jobs/cronjobs, and `metrics.k8s.io` pods/nodes. Applied with `make bootstrap-rbac` (the same human-run step as `deployer`).

Cluster-wide, not per-namespace, because the loop's questions cross namespaces: a CoreDNS warning is in `kube-system`, a collector restart in `observability`, a failed backup in `frontdesk`. What it deliberately omits, compared with the built-in `view` ClusterRole: **secrets** (`view` excludes them too, but saying so here matters), **configmaps** (the chart's ConfigMaps carry connection strings), and every subresource that is a write in disguise - `pods/exec`, `pods/portforward`, `pods/attach` are `create` verbs, and no rule here grants `create`. The issue's acceptance check is the negative test: `kubectl auth can-i create deployments -n frontdesk --as=system:serviceaccount:frontdesk:ops-reader` returns `no`; so does `get secrets`.

Its token is minted by Jason (`kubectl create token`, one year, the ADR-0014 recipe) into `~/.kube/ops-reader.kubeconfig` on the VPS, pointed at the node's tailnet address. It is never a GitHub secret and never mounted in a pod (`automountServiceAccountToken: false`).

### 4. Evidence is collected by a script; the model only reasons and files

`ops/agent/collect.py` (stdlib only, runs from the cron scheduler outside any venv) queries the three sources and prints one plain-text report: firing/pending alerts and down scrape targets; error-shaped Loki lines per container in `frontdesk` with timestamped samples; pods Waiting or restarted in the window, failed Jobs, Warning events collapsed per object/reason; and the open `ops` issues to dedupe against. A source that is unreachable is a section saying `UNREACHABLE`, not a crash - "Prometheus is down" is a finding.

`ops/agent/prompt.md` is the agent's instructions and travels with the evidence: `ops/agent/run.sh` prints both, and Hermes cron's `--script` mode injects that stdout into the prompt each run. So the *entire* behaviour of the ops agent - what it may read, the one command it may write with, what counts as a finding, the issue template, the noise list - is versioned in the repo and reviewed in PRs, the same way `worker/prompts/` is (REQUIREMENTS S7). The scheduler holds one symlink and one cron entry.

The split matters for cost and for trust. The script does the deterministic part for free; the model runs on Flash-class and reads a ~2 KB report rather than making twenty tool calls to gather it. And when the agent files an issue, the evidence block is a quote from a report a human can regenerate with one command, not a paraphrase of a tool call nobody saw.

### 5. What the agent may do is one command

`gh issue create --label agent:hermes --label ops`. Reads are unrestricted within what the ServiceAccount and the two HTTP endpoints allow. Everything else - `kubectl` mutations, `docker`, `helm`, `git push`, PRs, editing files, commenting on issues it did not open - is out. The ServiceAccount enforces the cluster half; the prompt states the rest, and AI-GOVERNANCE already says the same in its table. The `gh` identity is the VPS's OAuth login (`env -u GH_TOKEN`), which is the same identity Hermes files every other issue under; there is no separate bot account to manage.

### 6. Noise is listed, not learned

The prompt carries an explicit "do not file on these" list, seeded from the 24 h measurement above: `DNSConfigForming` (Hetzner hands the node three nameservers, k8s allows three) and the backup Job's first-attempt `connection refused` when the retry succeeds within the minute. Every future false positive gets added there, in a PR, with the reason. The alternative - a model that "remembers" - is not reviewable and does not survive a model swap.

### 7. Cadence and delivery

Every 6 hours (`0 */6 * * *`), matching the issue and the `for` windows. Delivery is `local`: the run's chat output is kept in cron history and goes nowhere else, because the product is the issue, not a message. Jason reads filed issues through the same `gh issue list` the morning brief already runs.

## Consequences

- REQUIREMENTS S6 is built. The README's guardrail 6 line changes from "specified, not built" to a pointer at `ops/agent/` and this ADR. REQUIREMENTS §11's "ops loop has filed at least one real issue from a real alert" stays open until it happens; the noise list means the first run is expected to file nothing.
- #52's acceptance criteria are all met or explicitly superseded (§1); it closes with this PR's merge and the post-merge steps. #29 stage 3's "alerts" half is this; its dashboards half (pipeline latency, tokens per org, eval trend) is still open and is what remains of #29 with 2b.
- `ops/` is a new top-level directory, linted by the worker's ruff invocation (`ruff check . ../ops` in both CI and `make lint`). It has no tests: the collector's logic is formatting over three JSON APIs, and a test would mock all three and prove nothing about the live shapes. Its verification is running it, which the PR body records.
- A wrong or noisy rule costs an unnecessary issue, not a page. That is the right failure mode for a first alert set and why Alertmanager was not worth its container.
- Post-merge, Jason-run, in order: `make bootstrap-rbac` (the SA); `kubectl create token ops-reader -n frontdesk --duration=8760h` into a kubeconfig at `~/.kube/ops-reader.kubeconfig` (recipe in `ops/agent/README.md`); the negative `can-i` checks; `docker compose up -d prometheus` on the VPS (the rules mount is new); the symlink and `hermes cron create` line from `run.sh`'s header; then one manual `hermes cron run`.

## Alternatives rejected

- **Deploy Alertmanager and satisfy #52's wording literally.** A fourth service and a `receivers:` block with nothing in it, so that a scheduled poller could read from a different URL. ADR-0026 deferred it for exactly this reason; the trigger it set ("an alert rule someone would act on") is met by writing the rules, not by adding the router.
- **Bind the agent to the built-in `view` ClusterRole.** Includes configmaps, which here hold connection strings, and is cluster-maintainer-defined - a k8s upgrade can widen it. A hand-written role is a diff someone reviews.
- **Scope the ServiceAccount to `frontdesk` only.** The backup Job is there, but the collector restart, the CoreDNS warning and the node conditions are not. Half the loop's questions would be unanswerable by construction.
- **Have the agent gather evidence with its own tool calls.** Twenty tool calls on a Flash-class model every 6 h to reproduce what a 200-line script does deterministically and for free, with the transcript as the only record. The script's output is the record.
- **Keep the prompt in `~/.hermes/cron` and the script in the repo.** The prompt *is* the policy - what the agent may do and what counts as a finding. Unversioned policy is what AI-GOVERNANCE exists to prevent.
- **Loki ruler / LogQL alerts instead of the collector's Loki queries.** Loki's ruler needs Alertmanager to deliver to; the collector already runs the same LogQL and hands the result to the reader directly.
