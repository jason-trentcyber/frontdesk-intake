# Ops agent (REQUIREMENTS S6, ADR-0040)

The sixth SDLC guardrail: every 6 hours a Hermes cron job on the VPS reads
alerts, logs and cluster state through read-only credentials and files a
GitHub issue - `agent:hermes` + `ops`, with quoted evidence, a hypothesis, a
proposed fix and a confidence - when something warrants one. It never
applies a change. Most runs file nothing.

| file | role |
|---|---|
| `collect.py` | Evidence collector. Stdlib only. Prometheus alerts + scrape health, error-shaped Loki lines per container, unhealthy pods / failed Jobs / Warning events via the `ops-reader` ServiceAccount, open `ops` issues for dedupe. Each source reports `UNREACHABLE` on its own rather than aborting. |
| `prompt.md` | The agent's instructions: what it may read, the one command it may write with, what counts as a finding, the noise list, the issue template. Versioned here so policy changes are PRs. |
| `run.sh` | Cron entry point: prints `prompt.md` then `collect.py`'s report. Hermes cron `--script` mode injects the stdout into the agent's prompt. |

Alert rules live in `deploy/observability/prometheus/rules/`; the
ServiceAccount in `deploy/bootstrap/rbac/ops-reader.yaml`. There is no
Alertmanager - the agent reads Prometheus's `/api/v1/alerts` directly
(ADR-0040 §1).

## Run it by hand

From the repo root on the VPS, with a kubeconfig for the `ops-reader`
ServiceAccount at `~/.kube/ops-reader.kubeconfig` (below):

```
python3 ops/agent/collect.py               # evidence only, 6 h window
OPS_LOOKBACK=24h python3 ops/agent/collect.py
bash ops/agent/run.sh                      # exactly what the cron job sees
```

Environment knobs are documented in `collect.py`'s docstring. Before
committing a change: `make lint` (ruff covers `ops/`), then run the
collector and read the output - it has no unit tests by decision
(ADR-0040 Consequences).

## One-time setup (human-run; agents do not apply infra)

1. **ServiceAccount** - applies `deploy/bootstrap/rbac/` including `ops-reader`:

   ```
   make bootstrap-rbac
   ```

2. **Negative tests** - the issue's acceptance criterion:

   ```
   export KUBECONFIG=infra/hetzner/kubeconfig
   kubectl auth can-i create deployments -n frontdesk --as=system:serviceaccount:frontdesk:ops-reader   # no
   kubectl auth can-i get secrets -n frontdesk --as=system:serviceaccount:frontdesk:ops-reader          # no
   kubectl auth can-i create pods/exec -n frontdesk --as=system:serviceaccount:frontdesk:ops-reader     # no
   kubectl auth can-i get pods/log -n frontdesk --as=system:serviceaccount:frontdesk:ops-reader         # yes
   kubectl auth can-i list events -n kube-system --as=system:serviceaccount:frontdesk:ops-reader        # yes
   ```

3. **Token + kubeconfig** on the VPS, same recipe as the deployer token in
   `deploy/bootstrap/README.md`, pointed at the node's tailnet address.
   Stays on this box; never a GitHub secret, never mounted in a pod.

   ```
   mkdir -p ~/.kube && chmod 700 ~/.kube
   TOKEN=$(kubectl create token ops-reader -n frontdesk --duration=8760h)
   CA=$(kubectl config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
   cat > ~/.kube/ops-reader.kubeconfig <<EOF
   apiVersion: v1
   kind: Config
   clusters:
     - name: frontdesk-node
       cluster:
         server: https://100.88.28.10:6443
         certificate-authority-data: ${CA}
   contexts:
     - name: ops-reader
       context:
         cluster: frontdesk-node
         user: ops-reader
   current-context: ops-reader
   users:
     - name: ops-reader
       user:
         token: ${TOKEN}
   EOF
   chmod 600 ~/.kube/ops-reader.kubeconfig
   unset TOKEN
   kubectl --kubeconfig ~/.kube/ops-reader.kubeconfig get pods -A            # works
   kubectl --kubeconfig ~/.kube/ops-reader.kubeconfig get secrets -n frontdesk   # Forbidden
   ```

   Rotate yearly (the `--duration`) by re-running this block.

4. **Prometheus picks up the rules** (the `rules/` bind mount is new):

   ```
   cd deploy/observability && docker compose up -d prometheus
   curl -s http://127.0.0.1:9090/api/v1/rules | grep -o '"name":"[A-Za-z]*"'   # four alert names
   ```

   If the container predates the bind mount, `up -d` recreates it; an already
   running container needs `docker compose restart prometheus` after any edit
   under `rules/`. The lifecycle API is off in this compose stack, so
   `POST /-/reload` returns `403 Lifecycle API is not enabled` - restart, do
   not reload.

5. **Schedule it** - one wrapper script, one cron entry (ADR-0041):

   `hermes cron create --script` resolves the path and refuses anything whose
   realpath leaves `~/.hermes/scripts/`, so a symlink into the repo fails with
   `Script path escapes the scripts directory via traversal`. Write a one-line
   wrapper instead; the policy and collector stay versioned in this repo.

   ```
   cat > ~/.hermes/scripts/frontdesk-ops.sh <<'EOF'
   #!/usr/bin/env bash
   exec bash "$HOME/code/frontdesk-intake/ops/agent/run.sh"
   EOF
   chmod +x ~/.hermes/scripts/frontdesk-ops.sh
   hermes cron create --name "frontdesk ops loop" --script frontdesk-ops.sh \
     --workdir ~/code/frontdesk-intake --deliver local "0 */6 * * *" \
     "Act on the ops-agent instructions and evidence report injected below."
   hermes cron run <job-id>      # first run now, rather than waiting for the tick
   hermes cron runs <job-id>     # read its output
   ```

## Proving a rule fires

`#52`'s last acceptance line, now "one alert rule fires and is observed by
the ops agent". Lower a threshold past the node's current value in
`rules/node.yaml` (e.g. `NodeLoadHigh` to `node_load15 > 0` with `for: 1m`),
`docker compose restart prometheus`, wait past the `for`, then
`python3 ops/agent/collect.py` shows it under `[FIRING]`. Restore the file
and restart again. Do not commit the lowered value.

Done twice on 2026-09-22; the second run is what the collector prints now:

```
- [FIRING] NodeLoadHigh severity=warning since=2026-09-22T15:31:04Z value=1.7e-01
  expr: node_load15 > 0
  summary: frontdesk 15-minute load above 8 for 30m
```

The summary still says 8 and 30m while the expression was `> 0`: annotations
template over `$labels` and `$value`, never over the live threshold. That is
why `collect.py` prints `expr:` from `/api/v1/rules` alongside `value=`
(ADR-0041 review). Read those two; the prose is only a hint.
