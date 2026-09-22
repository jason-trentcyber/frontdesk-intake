# ADR-0041: The ops-loop scheduler holds a one-line wrapper script, not a symlink; amends ADR-0040

Status: decided 2026-09-22 (#32 activation). Amends ADR-0040 §4's last sentence and its Consequences post-merge checklist. Everything else in ADR-0040 stands — this is a mechanism correction found while performing that checklist, not a change of decision.

## Context

ADR-0040 §4 ends: "The scheduler holds one symlink and one cron entry." `ops/agent/run.sh`'s header and `ops/agent/README.md` §5 both carried the same recipe:

```
ln -s ~/code/frontdesk-intake/ops/agent/run.sh ~/.hermes/scripts/frontdesk-ops.sh
```

It cannot work. Running the post-merge checklist on the VPS:

```
$ hermes cron create --name "frontdesk ops loop" --script frontdesk-ops.sh ...
Failed to create job: Script path escapes the scripts directory via traversal: 'frontdesk-ops.sh'
```

`hermes cron create --script` resolves the argument to a realpath and refuses anything landing outside `~/.hermes/scripts/`. A symlink into a repo checkout is precisely that, and the scheduler cannot distinguish it from the traversal it is defending against. The check is in the scheduler, not in this repo, so it is a constraint to design around rather than something to argue with.

The decision underneath §4 is untouched by this: the agent's entire behaviour — what it may read, the one command it may write with, what counts as a finding, the noise list, the issue template — must live in `ops/agent/prompt.md` in this repo and be reviewed in PRs, with the scheduler holding no policy. The symlink was one way to get there, named in passing as an implementation detail. It is the only part that is wrong.

## Decision

The scheduler holds a two-line wrapper script and one cron entry:

```
cat > ~/.hermes/scripts/frontdesk-ops.sh <<'EOF'
#!/usr/bin/env bash
exec bash "$HOME/code/frontdesk-intake/ops/agent/run.sh"
EOF
chmod +x ~/.hermes/scripts/frontdesk-ops.sh
```

`exec` rather than a plain call, so there is no extra shell in the process tree and `run.sh`'s exit status is the job's own. `$HOME` rather than `~` because the path is inside quotes. The wrapper contains no policy, no arguments and no environment — every knob `collect.py` reads has a default in its docstring, and changing one is a repo edit, not a scheduler edit. If the wrapper ever needs a second line of logic, that logic belongs in `run.sh` instead.

ADR-0040's Consequences checklist item "the symlink and `hermes cron create` line from `run.sh`'s header" reads "the wrapper script and `hermes cron create` line" under this ADR.

## Consequences

- One file on the VPS is not under version control, where before the intent was zero. It is two lines that name a path; the failure mode if it drifts is that the job runs nothing, visible in `hermes cron runs`. Accepted.
- Moving or renaming the repo checkout breaks the job silently until the next run's output is read. The same was true of the symlink.
- `ops/agent/run.sh`'s header, `ops/agent/README.md` §5 and this ADR carry the same recipe; the README is the one a human follows.
- Applied 2026-09-22: job `b928417e40d3`, `0 */6 * * *`, workdir the repo checkout, `--deliver local`.

## Alternatives rejected

- **Copy `run.sh` into `~/.hermes/scripts/` instead of pointing at it.** Removes the indirection, but puts a copy of the entry point outside version control where it can drift from the repo's — the exact thing ADR-0040 §4 exists to prevent. A wrapper that only names a path cannot drift in a way that silently changes behaviour.
- **Move `prompt.md`, `collect.py` and `run.sh` into `~/.hermes/scripts/` and drop the repo copies.** Satisfies the scheduler directly and deletes the indirection entirely. Rejected: it takes the agent's policy out of PR review, which is the whole of §4 and of REQUIREMENTS S7's argument for versioned prompts.
- **`hermes cron create` with an inline command instead of `--script`.** The prompt injection `--script` performs (script stdout into the agent's prompt) is what makes the evidence and the instructions travel together; an inline command would have to reproduce it.
