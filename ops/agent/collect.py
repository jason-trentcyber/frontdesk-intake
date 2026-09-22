#!/usr/bin/env python3
"""Evidence collector for the ops agent (#32, ADR-0040).

Runs on the Hermes VPS before each scheduled agent run and prints a plain-text
report the agent reasons over. It reads from exactly three places, all
read-only:

  * Prometheus on the VPS  - firing/pending alerts (rules/node.yaml) and
                             scrape-target health
  * Loki on the VPS        - error-shaped log lines from the frontdesk
                             namespace, counted per container with samples
  * the cluster            - via the `ops-reader` ServiceAccount kubeconfig:
                             unhealthy pods, restarts, failed Jobs, Warning
                             events

plus `gh issue list --label ops` so the agent can dedupe against what has
already been filed. Nothing here writes anywhere. A source that is
unreachable is reported as such in its own section rather than crashing the
run, because "Prometheus is down" is itself a finding.

Stdlib only: this runs from the Hermes cron scheduler, outside any venv.

    OPS_KUBECONFIG   path to the ops-reader kubeconfig (default ~/.kube/ops-reader.kubeconfig)
    OPS_PROM_URL     default http://127.0.0.1:9090
    OPS_LOKI_URL     default http://100.103.239.6:3100  (tailnet bind, ADR-0039)
    OPS_LOOKBACK     window for logs/events, default 6h (matches the schedule)
    OPS_REPO         GitHub repo for the dedupe list, default jason-trentcyber/frontdesk-intake
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta

KUBECONFIG = os.path.expanduser(os.environ.get("OPS_KUBECONFIG", "~/.kube/ops-reader.kubeconfig"))
PROM_URL = os.environ.get("OPS_PROM_URL", "http://127.0.0.1:9090").rstrip("/")
LOKI_URL = os.environ.get("OPS_LOKI_URL", "http://100.103.239.6:3100").rstrip("/")
LOOKBACK = os.environ.get("OPS_LOOKBACK", "6h")
REPO = os.environ.get("OPS_REPO", "jason-trentcyber/frontdesk-intake")
NAMESPACE = "frontdesk"
TIMEOUT = 15
SAMPLE_LINES = 5
LINE_MAX = 400

# What "error-shaped" means across the three log formats in the namespace:
# worker JSON (`"level": "ERROR"`), api pino (`"level":50`), and plain text
# from the backup/migrate/purge Jobs (`pg_dumpall: error:`). One regex so a
# new container's format is caught by default rather than missed.
ERROR_REGEX = r'"level":\s*(?:"(?:ERROR|CRITICAL)"|5\d)|(?i)\b(?:error|fatal|panic|traceback)\b'


def _parse_lookback(s: str) -> timedelta:
    m = re.fullmatch(r"(\d+)([smhd])", s)
    if not m:
        raise SystemExit(f"OPS_LOOKBACK must look like 30m/6h/1d, got {s!r}")
    n, unit = int(m.group(1)), m.group(2)
    unit_name = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}[unit]
    return timedelta(**{unit_name: n})


def _get_json(url: str, params: dict[str, str] | None = None) -> dict:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
        return json.load(resp)


def _kubectl(*args: str) -> dict:
    out = subprocess.run(
        ["kubectl", "--kubeconfig", KUBECONFIG, *args, "-o", "json"],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return json.loads(out.stdout)


def _truncate(s: str, n: int = LINE_MAX) -> str:
    s = s.strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def section(title: str):
    print(f"\n## {title}")


def report_alerts() -> None:
    section("Prometheus alerts (rules/node.yaml; no Alertmanager, by design)")
    try:
        alerts = _get_json(f"{PROM_URL}/api/v1/alerts")["data"]["alerts"]
    except Exception as e:  # noqa: BLE001 - every failure is a finding, not a crash
        print(f"UNREACHABLE: {PROM_URL} - {e}")
        return
    active = [a for a in alerts if a.get("state") in ("firing", "pending")]
    if not active:
        print("none firing or pending")
    for a in active:
        labels = a.get("labels", {})
        ann = a.get("annotations", {})
        print(
            f"- [{a['state'].upper()}] {labels.get('alertname')} severity={labels.get('severity')} "
            f"since={a.get('activeAt')} value={a.get('value')}"
        )
        if ann.get("summary"):
            print(f"  summary: {ann['summary']}")
        if ann.get("description"):
            print(f"  description: {_truncate(' '.join(ann['description'].split()))}")

    try:
        targets = _get_json(f"{PROM_URL}/api/v1/targets", {"state": "active"})["data"][
            "activeTargets"
        ]
    except Exception as e:  # noqa: BLE001
        print(f"targets: UNREACHABLE - {e}")
        return
    down = [t for t in targets if t.get("health") != "up"]
    if down:
        for t in down:
            print(
                f"- TARGET DOWN job={t['labels'].get('job')} url={t.get('scrapeUrl')} "
                f"last_error={_truncate(t.get('lastError', ''), 200)}"
            )
    else:
        print(f"scrape targets: all {len(targets)} up")


def report_loki(window: timedelta) -> None:
    section(f"Loki: error-shaped lines in namespace {NAMESPACE}, last {LOOKBACK}")
    now = datetime.now(UTC)
    start_ns = str(int((now - window).timestamp() * 1e9))
    end_ns = str(int(now.timestamp() * 1e9))
    base = f'{{k8s_namespace_name="{NAMESPACE}"}} |~ `{ERROR_REGEX}`'
    try:
        counts = _get_json(
            f"{LOKI_URL}/loki/api/v1/query",
            {
                "query": f"sum by (k8s_container_name) (count_over_time({base} [{LOOKBACK}]))",
                "time": end_ns,
            },
        )["data"]["result"]
    except Exception as e:  # noqa: BLE001
        print(f"UNREACHABLE: {LOKI_URL} - {e}")
        return
    if not counts:
        print("no error-shaped lines")
        return
    for r in sorted(counts, key=lambda r: -float(r["value"][1])):
        container = r["metric"].get("k8s_container_name", "?")
        print(f"- {container}: {int(float(r['value'][1]))} lines")
        # The label value goes back into a LogQL selector. Container names are
        # DNS labels, so this never matches today; it is a guard, not a fix.
        if not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?", container):
            print(f"  samples: skipped, container name {container!r} is not a DNS label")
            continue
        try:
            sample = _get_json(
                f"{LOKI_URL}/loki/api/v1/query_range",
                {
                    "query": f'{{k8s_namespace_name="{NAMESPACE}", k8s_container_name="{container}"}} |~ `{ERROR_REGEX}`',
                    "start": start_ns,
                    "end": end_ns,
                    "limit": str(SAMPLE_LINES),
                    "direction": "backward",
                },
            )["data"]["result"]
        except Exception as e:  # noqa: BLE001
            print(f"  samples: UNREACHABLE - {e}")
            continue
        lines = sorted(
            (
                (v[0], v[1], s["stream"].get("k8s_pod_name", ""))
                for s in sample
                for v in s["values"]
            ),
            reverse=True,
        )[:SAMPLE_LINES]
        for ts, line, pod in lines:
            when = datetime.fromtimestamp(int(ts) / 1e9, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            print(f"  {when} {pod}: {_truncate(line)}")


def report_cluster(window: timedelta) -> None:
    section("Cluster (ops-reader ServiceAccount, read-only)")
    if not os.path.exists(KUBECONFIG):
        print(f"NO KUBECONFIG at {KUBECONFIG} - see ops/agent/README.md to mint one")
        return
    try:
        pods = _kubectl("get", "pods", "-A")["items"]
    except subprocess.CalledProcessError as e:
        print(f"UNREACHABLE: kubectl get pods -A - {_truncate(e.stderr, 300)}")
        return
    except FileNotFoundError:
        print("kubectl not on PATH")
        return

    since = datetime.now(UTC) - window
    findings = 0
    for p in pods:
        ns, name = p["metadata"]["namespace"], p["metadata"]["name"]
        phase = p["status"].get("phase")
        for cs in p["status"].get("containerStatuses", []):
            waiting = cs.get("state", {}).get("waiting", {}).get("reason")
            term = cs.get("lastState", {}).get("terminated") or {}
            finished = term.get("finishedAt")
            recent_restart = finished and datetime.fromisoformat(finished) >= since
            if waiting and waiting not in ("ContainerCreating", "PodInitializing"):
                print(f"- {ns}/{name} container={cs['name']} WAITING reason={waiting}")
                findings += 1
            if cs.get("restartCount", 0) and recent_restart:
                print(
                    f"- {ns}/{name} container={cs['name']} restarts={cs['restartCount']} "
                    f"last={term.get('reason')}/exit={term.get('exitCode')} at={finished}"
                )
                findings += 1
        if phase in ("Failed", "Unknown"):
            print(f"- {ns}/{name} phase={phase} reason={p['status'].get('reason')}")
            findings += 1

    try:
        jobs = _kubectl("get", "jobs", "-A")["items"]
        for j in jobs:
            st = j.get("status", {})
            if st.get("failed"):
                print(
                    f"- JOB {j['metadata']['namespace']}/{j['metadata']['name']} failed={st['failed']} "
                    f"succeeded={st.get('succeeded', 0)} started={st.get('startTime')}"
                )
                findings += 1
    except subprocess.CalledProcessError as e:
        print(f"jobs: UNREACHABLE - {_truncate(e.stderr, 200)}")

    try:
        events = _kubectl("get", "events", "-A", "--field-selector", "type=Warning")["items"]
        recent = []
        for ev in events:
            last = (
                ev.get("lastTimestamp")
                or ev.get("eventTime")
                or ev["metadata"]["creationTimestamp"]
            )
            if datetime.fromisoformat(last) >= since:
                recent.append((last, ev))
        # Collapse repeats: one line per (namespace, object, reason).
        seen: dict[tuple[str, str, str], tuple[str, int, str]] = {}
        for last, ev in sorted(recent, key=lambda t: t[0], reverse=True):
            obj = ev.get("involvedObject", {})
            key = (
                ev["metadata"]["namespace"],
                f"{obj.get('kind')}/{obj.get('name')}",
                ev.get("reason", ""),
            )
            if key not in seen:
                seen[key] = (last, ev.get("count", 1), _truncate(ev.get("message", ""), 240))
        for (ns, obj, reason), (last, count, msg) in seen.items():
            print(f"- EVENT {ns} {obj} {reason} x{count} last={last}: {msg}")
            findings += 1
    except subprocess.CalledProcessError as e:
        print(f"events: UNREACHABLE - {_truncate(e.stderr, 200)}")

    if not findings:
        print("all pods healthy, no failed jobs, no Warning events in window")


def report_open_issues() -> None:
    section("Open `ops` issues already filed (dedupe against these)")
    try:
        out = subprocess.run(
            [
                "gh",
                "issue",
                "list",
                "--repo",
                REPO,
                "--label",
                "ops",
                "--state",
                "open",
                "--limit",
                "50",
                "--json",
                "number,title,createdAt,updatedAt",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
            env={
                k: v for k, v in os.environ.items() if k != "GH_TOKEN"
            },  # repo-scoped PAT 403s; use gh's own OAuth
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"UNREACHABLE: gh issue list - {getattr(e, 'stderr', e)}")
        return
    issues = json.loads(out.stdout)
    if not issues:
        print("none")
    for i in issues:
        print(
            f"- #{i['number']} {i['title']} (opened {i['createdAt'][:10]}, updated {i['updatedAt'][:10]})"
        )


def main() -> int:
    window = _parse_lookback(LOOKBACK)
    print(
        f"# ops evidence, collected {datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}, window {LOOKBACK}"
    )
    report_alerts()
    report_loki(window)
    report_cluster(window)
    report_open_issues()
    return 0


if __name__ == "__main__":
    sys.exit(main())
