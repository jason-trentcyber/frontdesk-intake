# ADR-0039: #29 stage 2a - the collector ships pod logs to Loki on the VPS; supersedes ADR-0026's Loki deferral

Status: decided 2026-09-22 (#29, #52). Supersedes ADR-0026's "When to add Loki" clause and its Decision 1 as it applies to Loki; Alertmanager stays deferred. Corrects ADR-0038 §1's stage table. Amends nothing else.

## Context

ADR-0038 split #29 into three stages and shipped stage 1 (PR #157): the worker emits valid JSON for the first time, api mints per-request UUIDs, and one bridge line joins the two. Every log line in the pipeline now carries `org_id`/`request_id`. Reading them is still `kubectl logs`.

ADR-0038 §1 described stage 2 as "OTel SDK + collector; blocked on a collector on the node (#52)". That was wrong in two ways, both visible on inspection rather than by argument:

**1. The collector already exists and is not the blocker - its config is.** `otel-collector` has run in the `observability` namespace for 13 days (bootstrap.sh, chart 0.172.1, image 0.159.0). Its rendered config receives OTLP on 4317/4318 and exports every pipeline to `debug` - its own stdout - and nothing else. `deploy/bootstrap/values/otel-collector.yaml` says so in its own header: "#52 points the exporters at the Hermes VPS once there is somewhere to send to - this file is expected to change then, not before." No `filelog` receiver, so it does not read pod logs; no Loki exporter, so it has nowhere to send them; `mode: deployment`, so it could not read every pod's logs even if configured to. It is a healthy placeholder.

**2. The dependency ran the other way.** ADR-0026 deferred Loki on the VPS with three triggers, any one sufficient. Its second was "#29 lands the OTel log pipeline, at which point Loki has something to receive." So Loki (#52) waits on the pipeline (#29), not the reverse. Stage 2 as ADR-0038 wrote it - SDK and collector together, gated on #52 - had the SDK (application code in two languages, new dependencies) bundled with the pipeline (a values file and a compose service) and both waiting on the thing the pipeline itself unblocks.

**ADR-0026's first trigger is also now met, by measurement.** ADR-0026 was decided on `free -m` readings of 229-516 MB available with Hermes at ~6 GB of the 7.7 GB VPS. Measured 2026-09-22 on `trentcyber-main` before writing this:

```
               total   used   free   shared  buff/cache  available
Mem:            7740   4906   1613     1096        2624       2834
Swap:           2047      0   2047
```

Hermes's footprint dropped to ~2.4 GB RSS. Prometheus and Grafana together measure ~170 MB (`docker stats`: 79.9 MiB and 94.5 MiB). Available memory is 2.8 GB - more than double #52's "1 GB free with Hermes running" criterion. There had been no swap at all; `dmesg` over 2½ weeks of uptime showed no OOM kills, but a box whose largest process is an agent runtime that swings by gigabytes during test runs resolves memory pressure by OOM-kill without it. A 2 GB swapfile was added the same evening (`/swapfile`, in fstab) as a precondition of putting anything else on the box, not as a way of fitting Loki - the numbers above are pre-swap.

So this is the moment ADR-0026 named: memory is there, and the pipeline is the piece of work that gives Loki something to receive. This ADR does the pipeline and Loki together, as one PR, because neither is verifiable without the other.

## Decision

**Stage 2 splits. This ADR is 2a: pod logs from the cluster to Loki on the VPS. No application code changes. 2b - the OTel SDK, `trace_id`/`span_id`, spans across api → queue → worker → LLM - is its own ADR when it is picked up, and can now be tested against a working log destination.**

### 1. The collector becomes a DaemonSet running the contrib image at the already-pinned version

`deploy/bootstrap/values/otel-collector.yaml`:

- `mode: daemonset`. A `filelog` receiver reads `/var/log/pods/` on the node it runs on; a Deployment reads only its own node's logs, which on a one-node cluster happens to be all of them, and then silently stops being all of them on the day a second node is added. DaemonSet is correct for the receiver regardless of node count, and the chart's DaemonSet mode mounts the `hostPath` volumes the receiver needs (`/var/log/pods`, `/var/lib/docker/containers` where applicable).
- `image.repository: otel/opentelemetry-collector-contrib` at the **same tag the cluster already runs (0.159.0)**. `filelog` and `loki` are contrib-only components; the core image cannot run this config. Pinning to the existing version means the only variable in this change is the config, not the collector.
- `presets.logsCollection.enabled: true`. The chart's own preset wires the `filelog` receiver with the k8s container-log parser and the pod/namespace/container attributes; hand-rolling the same receiver reproduces what the chart maintainers already test.
- `presets.logsCollection.includeCollectorLogs: false`. The collector's own logs looping through itself is the single most common self-inflicted Loki cardinality problem.

### 2. Logs export to Loki over the tailnet; the collector's other pipelines are untouched

The `logs` pipeline gets an `otlphttp` exporter with `endpoint: http://100.103.239.6:3100/otlp` - Loki 3.x's native OTLP ingest endpoint, which takes OTLP resource attributes as labels without a translation step. The Loki-specific `loki` exporter is deprecated in contrib in favour of this, and using the OTLP path means 2b's spans and metrics can reach the VPS through the same shape of config.

`100.103.239.6` is `trentcyber-main`'s tailnet address, verified this session by `tailscale status` on both ends: the node (`100.88.28.10`, tagged) and the VPS have an active direct connection. The address is a literal in the values file, the same way `prometheus.yml` carries the node's tailnet address as a literal scrape target - the tailnet gives it stability, and a DNS layer would be a new dependency to run.

`metrics` and `traces` pipelines keep the `debug` exporter. Nothing sends to them yet; 2b changes that and decides their destinations then.

### 3. Loki joins the VPS compose; Alertmanager still does not

`deploy/observability/compose.yaml` gains one service:

- `grafana/loki:3.7.8` (current release, checked 2026-09-22).
- `network_mode: host`, binding `0.0.0.0:3100`, **not** `127.0.0.1` - this is the one service in the stack that must accept a connection from another machine, and that machine reaches it over the tailnet. The tailnet ACL and the VPS host firewall are the boundary (§4). Loki's own auth is off (`auth_enabled: false`) - single tenant, single writer, same reasoning as Grafana's anonymous viewer.
- Filesystem storage under a named volume; TSDB index; **7-day retention** via the compactor. Prometheus keeps 15d; logs are larger per day and the ops loop (#32) reads the last few hours. Raise it when a real question needs older logs.
- Memory limit **512M**, set from the measurement above rather than from the box's headroom. Loki's ingester holds chunks in memory before flushing; 512M is comfortable for one node's logs and leaves >2 GB available. It is measured after apply, and the limit is revised then if steady state says so, the same way ADR-0026 §6 set Prometheus and Grafana.
- A Loki datasource is provisioned into Grafana read-only from the repo, next to the Prometheus one.

**Alertmanager stays deferred.** ADR-0026's third trigger - an alert rule someone would act on - is still unmet. That rule is #32's, and it lands with #32.

### 4. The VPS host firewall admits port 3100 from the tailnet interface only

The VPS's ufw is default-deny inbound with 2222/80/443 open. The tailnet interface (`tailscale0`) is not exempted, so a connection from the node to `100.103.239.6:3100` is dropped today. One rule is needed:

```
sudo ufw allow in on tailscale0 to any port 3100 proto tcp comment 'loki ingest from tailnet (ADR-0039)'
```

`in on tailscale0` binds the rule to the interface, so the port is not reachable from the public address regardless of what binds it. This is a host firewall change and it is a **Jason-run step**, listed in the PR body as such, not applied by an agent (AGENTS.md: no agent applies infra). ADR-0028 is the precedent for treating a host firewall as a real control on this box, and the reason it is recorded here rather than done quietly.

### 5. ADR-0038 §1's stage table is corrected by this ADR, not edited

ADR-0038 is decided; its table row for stage 2 stays as written, with a status-line pointer to this ADR. The corrected table:

| Stage | Contents | Blocked on | Status |
|---|---|---|---|
| 1 | correlation fields in existing logs; no SDK, no dependency | nothing | shipped, #157 |
| 2a (this ADR) | collector → Loki pipeline for pod logs; Loki on the VPS | nothing (ADR-0026 triggers 1 and 2 met) | — |
| 2b | OTel SDK in api/worker; `trace_id`/`span_id`; spans api → queue → worker → LLM | 2a, so spans have a destination to test against | — |
| 3 | dashboards over logs+traces; alert rules; Alertmanager | 2b for the trace panels; #32 for the alert rule | — |

### 6. Not done here

- **No `web/` logs beyond what its pods already emit.** `db/src/logger.ts` output is JSON and arrives via `filelog` like every other pod's stdout. Request ids for `web/` are 2b's.
- **No Loki alerting rules, no Grafana log dashboards.** Stage 3's. This ADR makes the logs *queryable* in Grafana's Explore; it does not design views over them.
- **No change to the cluster NetworkPolicy.** `observability-default-deny.yaml` denies *ingress* to the namespace; the collector needs *egress* to the VPS, which is unrestricted, and the policy header says so.
- **No cadvisor/per-pod metrics.** ADR-0026's named follow-up (a read-only SA scoped to `nodes/metrics`) is unchanged and still open.

## Consequences

- Reading the logs of any pod, filtered by `org_id` or `request_id`, is a Grafana Explore query over the tailnet instead of `kubectl logs` with `grep`. The stage-1 fields become the thing they were for.
- The collector's memory limit (256Mi) is unchanged; the `filelog` receiver's footprint on one node's log volume is small. Measured after apply.
- The VPS runs three observability services. Measured after apply with the same `free -m` / `docker stats` pair as ADR-0026, recorded in the PR. If available memory falls below 1 GB with Hermes running, the retention or the Loki limit comes down first, and this ADR's §3 numbers get a status pointer.
- REQUIREMENTS N3's "Loki" is met. "kube-prometheus-stack", "OTel" (the SDK half), and the three named dashboards remain unmet.
- `bootstrap.sh` is unchanged - the same `helm upgrade --install` with the same pinned chart version picks up the new values. Re-running it is the deploy step for the cluster half.
- #52's acceptance criteria: "Loki shows k3s pod logs" and "VPS free memory stays above 1 GB with Hermes running" become checkable with this PR. "One test alert fires to Alertmanager" remains open against stage 3. #52 stays open until then, per ADR-0026's own "not closed on a partial implementation."

## Alternatives rejected

- **Keep `mode: deployment` and add `filelog`.** Works on one node, and stops working silently on the day there are two. The chart's DaemonSet mode exists for exactly this receiver.
- **The deprecated `loki` exporter instead of `otlphttp`.** Contrib has marked it deprecated in favour of Loki's native OTLP endpoint; taking it on now is adopting a migration. OTLP also means 2b's traces and metrics use the same exporter shape.
- **Promtail / Grafana Alloy on the node instead of the collector.** A second agent on the node doing what the already-running collector can do. The collector is the component #29 named and the one 2b builds on.
- **Push logs from the app processes directly (pino transport, Python handler) to Loki.** Bypasses the collector entirely and puts a network destination in every service's logging config. The pipeline's whole value is that the app writes to stdout and the platform ships it.
- **Bind Loki to `127.0.0.1` and reverse-tunnel from the node.** An SSH tunnel as a permanent ingest path is a process to keep alive and a key to manage. The tailnet already is the private network; using it as one is the point of ADR-0013.
- **Open 3100 without the interface constraint.** Reachable from the public address, defended only by ufw's default policy ordering. `in on tailscale0` costs nothing and makes the exposure explicit.
- **Do 2a and 2b as one PR.** 2a is two files; 2b is SDK integration in two languages with new dependencies and an eval-gate fixture check. Bundling them gates a two-file infra change on application work, which is what ADR-0038's original stage 2 did and why it was wrong.
- **Edit ADR-0038's stage table in place.** It is decided. The correction is here, with a status pointer there.
