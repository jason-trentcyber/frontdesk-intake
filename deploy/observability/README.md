# Observability (Prometheus + Grafana, on the Hermes VPS)

Watches the frontdesk k3s node from `trentcyber-main` over the tailnet.
ADR-0010 put the stack off-node; **ADR-0026** records why it is two services
rather than #52's four, and what has to change before Loki and Alertmanager
join.

## What this does and does not do

- **Does**: node memory, CPU by mode, load, root filesystem, disk I/O,
  network throughput, uptime, and scrape health for the `frontdesk` node,
  every 30 s, retained 15 days.
- **Does not**: per-pod or per-container metrics (needs the cadvisor
  follow-up in ADR-0026), log aggregation, or alerting. Nothing here pages
  anyone. Reading pod logs is still `kubectl logs`.

## Run it

```
cd deploy/observability
printf 'GRAFANA_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
chmod 600 .env
docker compose up -d
```

`.env` is gitignored and has no default in `compose.yaml` — compose fails
rather than starting with a guessable password.

Both services bind `127.0.0.1` only. Nothing is published publicly.

## Reach Grafana

From the MacBook, over the tailnet:

```
ssh -L 3300:127.0.0.1:3300 trentcyber
```

then open <http://127.0.0.1:3300/d/frontdesk-node>. Anonymous access is
`Viewer`, so no login is needed to look; the `admin` account from `.env`
gates edits.

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
and crash-loops. `provisioning/datasources/prometheus.yaml` carries a
`deleteDatasources` block so it is idempotent against an existing install.
The datasource uid is pinned to `prometheus` because the dashboard JSON
references it; if it were auto-generated, every panel would render empty with
no error shown.

## Footprint (measured, not documented defaults)

| service | steady-state | limit |
|---|---|---|
| prometheus | 30 MiB | 320M |
| grafana | 98 MiB | 200M |

ADR-0026 has the VPS memory arithmetic that constrains these.
