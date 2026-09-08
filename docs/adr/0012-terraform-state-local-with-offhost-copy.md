# ADR-0012: Terraform state stays local, with an off-host copy; no remote backend yet

Status: decided 2026-09-08. Refines the "State backend is documented in `infra/hetzner/README.md`" line of `docs/conventions.md` → Infra. Does not amend ADR-0001 or ADR-0010.

## Context
The `infra/hetzner` root was applied for the first time on 2026-09-07 from the Hermes VPS (`trentcyber-main`). Its state, `infra/hetzner/terraform.tfstate` (~16 KB), exists on that one disk. The README said "keep `terraform.tfstate*` backed up" without saying how, and a follow-up branch (`claude/tfstate-backup`) drafted a Hetzner Object Storage `s3` backend with `use_lockfile`, bumping `required_version` to 1.10 to support it.

That draft answered a question nobody had asked. The project constraint (REQUIREMENTS N6, and the standing preference recorded in ADR-0010's rejected list) is to avoid new paid services when hardware already paid for can do the job. Object Storage is a new line item (~€5/mo minimum) and a new credential pair to manage, and the branch was not mergeable without both existing first.

What the state actually protects, checked on 2026-09-08:

- 7 managed resources: `hcloud_server` (165032630), `hcloud_floating_ip` (148530476) and its assignment, `hcloud_firewall` (11588996), two `hcloud_ssh_key` (118483504, 118483503), and two `null_resource` provisioner anchors.
- 2 data sources (Cloudflare IP lists), refreshed on every plan.
- No secrets. `user_data` is stored as a hash; SSH keys are public halves; `HCLOUD_TOKEN` and the private key are never in state.

Every managed resource has a stable Hetzner ID and can be re-adopted with `terraform import`. Losing the state file costs about fifteen minutes of imports, not the infrastructure.

Remote state exists to solve two problems: durability across host loss, and locking between concurrent operators. Today there is one operator, one shell, and no CI apply job (`docs/conventions.md` → Infra names CI-on-merge as the target; #18 is the first step toward it). Locking has nothing to lock against.

## Decision
- State stays local to the VPS clone: `infra/hetzner/terraform.tfstate`, git-ignored, as today.
- After every `apply`, the operator copies `terraform.tfstate` off-host to their workstation. The README gives the exact command. The file has no secrets, so the copy needs no special handling beyond not being committed.
- The README records the resource IDs and the import recipe, so recovery after host loss does not depend on the lost host. The recipe was run for real on 2026-09-08 (scratch copy, empty state, live account): it surfaced that an imported `hcloud_server` plans a replacement because `user_data` and `ssh_keys` are replace-on-change and come back different from the API. `main.tf` now sets `lifecycle.ignore_changes = [ssh_keys, user_data]` on the server; with that, post-import `plan` is exactly the two `null_resource` anchors. That is the acceptance check for this decision and it passed.
- `required_version` stays at `>= 1.6`. Nothing in this root needs newer.
- The trigger for revisiting is concrete: the first CI apply job, or a second human operator. Whichever comes first opens a new ADR that supersedes this one and picks a backend then, with the requirements of that moment (locking, CI credentials, cost) in hand.

## Consequences
- Zero new cost, zero new vendors, zero new credentials.
- The off-host copy is a manual step after each apply. Applies are rare (one so far) and always human-run (AI-GOVERNANCE: agents do not apply infra), so the step lives next to the apply in the README rather than in automation.
- Worst-case recovery is documented and bounded: re-import by ID, then `terraform plan` must show no changes. This is a better-understood failure mode than a half-migrated remote backend.
- The `claude/tfstate-backup` branch is closed without merging. Its `backend.tf.example` was reviewed and is a sound starting point if the superseding ADR picks Hetzner Object Storage; the two things it lacked were `skip_metadata_api_check = true` and a bucket with versioning enabled at creation.
- `docs/conventions.md` → Infra continues to point at the README for state; no change needed there.

## Rejected
- **Hetzner Object Storage `s3` backend now.** Solves host loss and locking, at ~€5/mo and a second credential pair, for a single-operator root whose state can be rebuilt by import in minutes. Right answer later, premature now. Kept as the leading candidate for the superseding ADR.
- **Commit the state to git (encrypted or not).** The state has no secrets today, but a future resource could put one there, and the convention that state is never in the repo is worth more than the convenience. Also, the repo is public.
- **Second copy on the same host** (`~/backups/` on the VPS, made 2026-09-08). Guards against an in-place mistake, not against the host. Kept as a bonus, not counted as the backup.
- **Dropping state durability entirely** ("just re-import if it happens"). The import recipe is the fallback, not the plan; a 16 KB `scp` is cheaper than fifteen minutes of imports under pressure.
