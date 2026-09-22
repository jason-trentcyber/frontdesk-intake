#!/usr/bin/env bash
# The ops agent's cron entry point (#32, ADR-0040). Hermes cron runs this
# with `--script` before each agent run and injects its stdout into the
# prompt, so the instructions and the evidence travel together and both
# live in the repo. The scheduler side is one symlink:
#
#   ln -s ~/code/frontdesk-intake/ops/agent/run.sh ~/.hermes/scripts/frontdesk-ops.sh
#   hermes cron create --name "frontdesk ops loop" --script frontdesk-ops.sh \
#     --workdir ~/code/frontdesk-intake --deliver local "0 */6 * * *" \
#     "Act on the ops-agent instructions and evidence report injected below."
#
# Exit non-zero only if the prompt itself is missing; a collector failure is
# reported inside the evidence (each source has its own UNREACHABLE line)
# rather than aborting the run, because "Loki is down" is what the agent
# exists to notice.
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

cat "$HERE/prompt.md" || exit 1
python3 "$HERE/collect.py" 2>&1 || echo "COLLECTOR EXITED $? - treat the sections above as partial"
