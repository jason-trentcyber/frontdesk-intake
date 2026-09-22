# Observability (Prometheus + Loki + Grafana, on the Hermes VPS)

Watches the frontdesk k3s node from `trentcyber-main` over the tailnet.
ADR-0010 put the stack off-node; **ADR-0026** records why it started as two
services rather than #52's four; **ADR-0039** adds Loki once 0026's triggers
were met and gives the cluster's otel-collector something to ship. There is no
Alertmanager: the alert rules under `prometheus/rules/` are read by the ops
agent (`ops/agent/`, ADR-0040) straight from Prometheus's `/api/v1/alerts`.

## What this does and does not do

- **Does**: node memory, CPU by mode, load, root filesystem, disk I/O,
  network throughput, uptime, and scrape health for the `frontdesk` node,
  every 30 s, retained 15 days. **Every pod's logs**, shipped by the
  cluster's otel-collector over the tailnet, retained 7 days, queryable in
  Grafana Explore by namespace/pod/container and by the JSON fields the
  app writes (`org_id`, `request_id`, ADR-0038).
- **Does not**: per-pod or per-container metrics (needs the cadvisor
  follow-up in ADR-0026), traces (#29 stage 2b), log dashboards (stage 3).
  Nothing here pages anyone: the four node alert rules in
  `prometheus/rules/node.yaml` are evaluated by Prometheus and read by the
  ops agent every 6 h (`ops/agent/`, ADR-0040), which files an issue rather
  than sending a notification. After editing a rule, `promtool check rules`
  on the pinned image (recipe in the file header) and
  `docker compose up -d prometheus` — the rules are a bind mount, so a
  restart is enough, but CI does not validate them.

## Run it

```
cd deploy/observability
printf 'GRAFANA_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
chmod 600 .env
docker compose up -d
```

`.env` is gitignored and has no default in `compose.yaml` — compose fails
rather than starting with a guessable password.

**On an existing install, `up -d` only starts services that are new or
changed.** Grafana reads `provisioning/` at startup, so a new datasource or
dashboard file is invisible until Grafana restarts — `up -d` alone left the
Loki datasource missing the first time (Grafana had been up 10 days). After
any change under `grafana/`:

```
docker compose restart grafana
```

Prometheus and Grafana bind `127.0.0.1` only. **Loki binds the VPS's tailnet
address (`100.103.239.6:3100`)** — not loopback, which the node cannot reach,
and not `0.0.0.0`, which ADR-0028 forbids. The bind address is the control;
it is reachable from the tailnet and from nothing else. Nothing is published
publicly.

## One-time firewall step (Jason-run, ADR-0039 §4)

The VPS's ufw is default-deny inbound and does not exempt `tailscale0`, so
the collector's packets are dropped before they reach Loki's listener until
this rule exists. It makes the already-scoped port *reachable*; the bind
address above is what makes it *safe* (ADR-0028 §2).

```
sudo ufw allow in on tailscale0 to any port 3100 proto tcp comment 'loki ingest from tailnet (ADR-0039)'
```

Verify from the VPS itself:

```
sudo ufw status | grep 3100
curl -s -o /dev/null -w '%{http_code}\n' http://100.103.239.6:3100/ready
```

`200` from `/ready` means Loki is up on the tailnet address; the ufw line
means the node can reach it.

## The cluster half

`deploy/bootstrap/values/otel-collector.yaml` turns the collector into a
DaemonSet that tails `/var/log/pods` and exports to Loki's OTLP endpoint.
Apply it the same way as every other bootstrap component — `make bootstrap`
re-runs the pinned `helm upgrade --install`. Then check logs are arriving:

```
curl -s 'http://100.103.239.6:3100/loki/api/v1/labels' | python3 -m json.tool
```

Should list `k8s_namespace_name`, `k8s_pod_name`, `k8s_container_name`,
`k8s_node_name`. An empty label set with Loki `/ready` at 200 means the
collector is not reaching it — check the ufw rule first, then
`kubectl -n observability logs ds/otel-collector-opentelemetry-collector-agent`
for `connection refused` against `100.103.239.6:3100`.

## Reach Grafana

From the MacBook, over the tailnet:

```
ssh -L 3300:127.0.0.1:3300 trentcyber
```

then open <http://127.0.0.1:3300/d/frontdesk-node>. Anonymous access is
`Viewer`, so no login is needed to look; the `admin` account from `.env`
gates edits.

**Logs:** <http://127.0.0.1:3300/explore> → datasource `Loki` → e.g.
`{k8s_namespace_name="frontdesk"} | json | request_id="<uuid>"` follows one
request through api and worker on the ids ADR-0038 put there. Explore is a
sidebar entry (compass icon), not a dashboard. It is visible to the
anonymous viewer only because `GF_USERS_VIEWERS_CAN_EDIT` is set in
`compose.yaml` — Grafana 12 hides it from Viewers otherwise, and the first
attempt to read logs ended in a login as `admin` to find it.

## Editing a dashboard

Edit the JSON in `grafana/dashboards/` and `docker compose restart grafana`.
Provisioning is `allowUiUpdates: false` on purpose — the repo is the source
of truth, so a rebuild cannot lose a change made in a browser. Changes made
in the UI will not persist.

## If the graphs look wrong

Check the "Scrape health" panel first. A failed scrape makes graphs go
**flat**, not wrong, and that reads as "nothing is happening" rather than
"the data is missing". Then:

```
curl -s http://127.0.0.1:9090/api/v1/targets?state=active \
  | python3 -m json.tool | grep -E 'job|health|lastError'
curl -s -o /dev/null -w '%{http_code}\n' http://100.88.28.10:9100/metrics
```

The second one is the node's exporter over the tailnet; 200 means the target
is fine and the problem is on this side.

## Gotcha worth knowing

Grafana cannot re-provision a **uid change** onto a datasource that already
exists — it exits with `Datasource provisioning error: data source not found`
and crash-loops. Both files in `provisioning/datasources/` carry a
`deleteDatasources` block so they are idempotent against an existing install.
The datasource uids are pinned (`prometheus`, `loki`) because dashboard JSON
references them; if they were auto-generated, every panel would render empty
with no error shown.

## Footprint (measured, not documented defaults)

| service | steady-state | limit |
|---|---|---|
| prometheus | 30 MiB (44 MiB after 11 days) | 320M |
| grafana | 96 MiB | 200M |
| loki | 60 MiB (first hour, one node's logs) | 512M |
| otel-collector (on the node, DaemonSet) | 90 Mi | 256Mi |

ADR-0026 and ADR-0039 have the VPS memory arithmetic that constrains these.
Loki and the collector were measured 2026-09-22 in the first hour after
apply; VPS available memory was 2,834 MB before and after, i.e. unchanged.
Re-measure the collector if `kubectl -n observability top pod` shows it
above ~200 Mi — the 256Mi limit predates the `filelog` receiver.
