# ADR-0026: Observability ships as Prometheus + Grafana only; Loki and Alertmanager wait for memory

Status: decided 2026-09-11, applied

Narrows the scope of issue #52, whose body specifies "Prometheus, Loki,
Grafana, Alertmanager, with mem limits totalling <= 1.7 GB". ADR-0010's
decision — the observability stack runs on the Hermes VPS, not on the 4 GB
k3s node — is unchanged and is what this implements.

## Context

#52's acceptance criteria include "VPS free memory stays above 1 GB with
Hermes running". Measured on `trentcyber-main` before writing any of this
(2026-09-11, ~19:50 CT):

```
total  used  free  shared  buff/cache  available
7740   6437   229     979        1572        1303      (MB)
```

and forty minutes later, with a second Claude Code session open, **516 MB
available**. The top consumers are Hermes itself — several Python processes
between 250 and 575 MB, plus `claude` and a headless Chrome. Summed, the
Hermes side of the box is ~6 GB of the 7.7 GB.

So the #52 stack cannot be built as specified: a 1.7 GB budget does not fit
in 516 MB, and even a trimmed four-service stack would leave the box with no
headroom and put Jason's interactive `claude` sessions in reach of the OOM
killer. The constraint is not the cluster this time; it is the machine doing
the watching.

Of the four services, **Loki is the one that costs**. Prometheus and Grafana
measured at 30 MB and 98 MB respectively once running (below). Loki with even
a modest ingester and a filesystem store is several hundred MB before it
indexes anything, and it is the only one of the four that has no value
without the second half of #29 (the OTel collector in the cluster shipping
logs to it). Alertmanager is small but has nothing to route: there are no
alert rules yet, and `Watchdog`-style self-tests are not what #52's "one test
alert fires" is asking for.

What *is* already in place and was verified rather than assumed:

- `node-exporter` runs `hostNetwork: true` in the cluster, so it answers on
  the node's tailnet address directly — `curl http://100.88.28.10:9100/metrics`
  returns 200. No new exposure is needed to scrape it.
- `kube-state-metrics` and an `otel-collector` have been running in the
  cluster's `observability` namespace for three days. Neither is reachable
  from outside: both are ClusterIP with no `hostNetwork`.
- kubelet's `/metrics/cadvisor` on `:10250` *does* answer over the tailnet,
  but only with a client certificate, and the only one available is the
  cluster-admin cert in `infra/hetzner/kubeconfig`.

## Decision

**1. Two services, not four.** `deploy/observability/compose.yaml` runs
Prometheus and Grafana. Loki and Alertmanager are deferred, not cancelled;
the trigger to add them is stated below.

**2. Scrape only node-exporter, over the tailnet.** One target, no new
credential, no new exposure. `prometheus.yml` records why each other
candidate source is absent so the next reader does not re-derive it.

**3. Cluster-admin credentials do not go in a scrape config.** cadvisor
per-pod metrics are worth having and are explicitly a follow-up: a read-only
ServiceAccount scoped to `nodes/metrics`, minted the same way ADR-0014's
deployer SA is. Using the admin cert to draw a memory graph would trade the
cluster's blast radius for a dashboard panel.

**4. Nothing binds to a public interface.** Both services bind
`127.0.0.1` (Prometheus `:9090`, Grafana `:3300`). Grafana is reached over
the tailnet or an SSH tunnel, the same way the Hermes dashboard is. Grafana
anonymous access is enabled at `Viewer` — the tailnet ACL is the
authentication boundary, and the admin account (password from a gitignored
`.env`, no default) still gates edits.

**5. Dashboards are provisioned read-only from the repo.**
`allowUiUpdates: false`. The JSON in `deploy/observability/grafana/dashboards/`
is the source of truth, so a container rebuild cannot silently lose an edit
made in a browser.

**6. Memory limits come from measurement.** Prometheus 320M, Grafana 200M —
set after observing 30 MB and 98 MB steady-state, leaving room for
Prometheus' TSDB head block to grow with cardinality rather than sizing to
the number observed in the first minute.

## Measured after applying

```
observability-prometheus-1   30.22MiB / 320MiB   0.00% CPU
observability-grafana-1      98.23MiB / 200MiB   0.45% CPU
```

VPS available memory 352 MB with both running, Hermes and a `claude` session
active. Prometheus targets: `node-exporter` up, `prometheus` up. All 16
queries across the dashboard's 10 panels return a non-empty series, checked
individually through Grafana's own datasource proxy rather than by eye.

## When to add Loki and Alertmanager

Any one of:

- The VPS gets more memory, or the Hermes footprint on it drops, such that
  1 GB is free with Hermes running — #52's own criterion.
- #29 lands the OTel log pipeline, at which point Loki has something to
  receive and the "read the logs without `kubectl`" argument becomes real.
- An alert rule exists that someone would act on. Alertmanager routing
  nothing is ceremony; the ops loop (#32) is the consumer that makes it
  worth running.

Until then #52 stays open with this ADR linked, rather than being closed on
a partial implementation.

## Consequences

- There is now a live dashboard of the node that every memory-sizing
  argument in ADR-0010, ADR-0023 and ADR-0025 has been conducted against with
  point-in-time `free -m` readings. Those arguments get a time series.
- **No per-pod metrics yet.** The worker's RSS against its 512Mi limit —
  the number ADR-0023 and ADR-0025 both turn on — is still only observable
  via `kubectl top`. That is the single most valuable thing the cadvisor
  follow-up would add, and it is why that follow-up is named rather than
  vague.
- No log aggregation. Reading logs is still `kubectl logs`.
- No alerting. Nothing pages anyone; this is a dashboard you look at. Stated
  plainly because a monitoring stack that appears to alert and does not is
  worse than one that obviously does not.
- REQUIREMENTS N3 (kube-prometheus-stack, Loki, OTel, three named
  dashboards) remains unmet. This is a step toward it, not it.

## Rejected

- **The full four-service stack at reduced limits.** Loki under ~200 MB
  either drops logs or thrashes, and discovering which one in production is
  worse than not running it. The box does not have the memory today; saying
  so is cheaper than tuning around it.
- **Running the stack on the cluster node instead.** ADR-0010 decided
  against this for the same reason it is being decided again here: the 4 GB
  node is at 90 % of allocatable in chart limits already (ADR-0025).
- **Scraping cadvisor with the admin kubeconfig's client certificate.** It
  works — verified — and it is the wrong trade. A scoped read-only SA is a
  contained piece of work; a cluster-admin credential in a long-lived
  config file is a standing risk.
- **Exposing Grafana publicly behind Cloudflare.** More attack surface for a
  dashboard with one viewer. The tailnet already solves it (ADR-0013).
- **A Grafana password in the compose file or a default value.** The
  variable is required with no fallback, so compose fails loudly rather than
  starting with something guessable.
- **Editing #52's issue body to match what shipped.** The gap between what
  was specified and what fits is the interesting part of this decision, and
  it belongs in an ADR where it is dated and reviewable.
