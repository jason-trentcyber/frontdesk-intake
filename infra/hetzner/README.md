# infra/hetzner

Terraform root that provisions the single Hetzner Cloud box the whole stack
runs on (ADR-0001): one cx23 (x86, 2 vCPU / 4 GB; ADR-0010)
cloud-init that turns the box into a one-node k3s cluster with Traefik and
servicelb disabled (ingress-nginx replaces Traefik, per ADR-0002).

## State

Local state (`terraform.tfstate` in this directory, git-ignored) for now —
there's one operator and one environment, and a remote backend is one more
thing to provision before there's anything to provision it for.

Move to a remote backend before a second person or a CI apply job touches
this root: Hetzner Object Storage (S3-compatible) via the `s3` backend. The
config is drafted in `backend.tf.example` — once a bucket and an Object
Storage key pair (separate from `HCLOUD_TOKEN`) exist, copy it to
`backend.tf` (git-ignored) and run `terraform init -migrate-state` from
wherever `terraform.tfstate` currently lives.

**2026-09-08 stopgap:** `terraform.tfstate`/`.backup` were only ever on one
disk with no second copy. A dated copy of both files now also lives at
`~/backups/frontdesk-hetzner-tfstate/` on the same host. That guards against
an in-place mistake clobbering the only copy; it does **not** guard against
losing the host, which is the actual risk. Do the migration.

Migration, once the bucket and key pair exist:

```
cd infra/hetzner
cp backend.tf.example backend.tf          # then edit bucket/region/endpoint
export AWS_ACCESS_KEY_ID=...              # Object Storage key, not HCLOUD_TOKEN
export AWS_SECRET_ACCESS_KEY=...
terraform init -migrate-state             # answer "yes" to copy existing state
terraform plan                            # must report no changes
```

`terraform plan` reporting **no changes** is the check that the migration
worked: same state, new home. If it wants to create the server, stop — the
state did not come across and the local file is still the real one.

## Prerequisites

- `HCLOUD_TOKEN` exported in your shell (the hcloud provider reads it
  natively; see #2 — it's already in the VPS env).
- An SSH keypair. Copy `terraform.tfvars.example` to `terraform.tfvars` and
  set `ssh_public_key` to the public half; `ssh_private_key_path` (variables.tf)
  defaults to `~/.ssh/id_ed25519`.
- `admin_ips` and `vps_ip` in `terraform.tfvars` — see below.

Per `docs/conventions.md`: never `apply` from a laptop for anything CI
applies on merge. This root has no CI apply job yet (only `terraform fmt`/
`validate` run in CI, matrix'd with `infra/aws`), so until #18 or a follow-up
wires one up, a human runs `apply`/`destroy` here directly, as the one
exception, with the token from the VPS env.

## Usage

```
cd infra/hetzner
cp terraform.tfvars.example terraform.tfvars   # fill in real values
terraform init
terraform plan
terraform apply
```

`apply` also waits for cloud-init to finish on the new box and fetches
`/etc/rancher/k3s/k3s.yaml`, rewritten from `127.0.0.1` to the floating IP,
to `./kubeconfig` (git-ignored).

## Verifying against the #15 acceptance bar

```
terraform apply                                  # creates the box
KUBECONFIG=./kubeconfig kubectl get nodes         # Ready
curl -m5 https://<floating_ip>/                   # unreachable from a non-Cloudflare IP
terraform destroy && terraform apply              # clean re-apply
```

## Firewall

- `22/tcp` from `admin_ips` (Jason) and `vps_ip` (Hermes).
- `80/tcp` and `443/tcp` from Cloudflare's published ranges only
  (`data.http` reads `https://www.cloudflare.com/ips-v4` and `/ips-v6` at
  plan/apply time, so the list never goes stale in committed code).

## Not yet here

- Remote state backend migration (config drafted in `backend.tf.example`, see above — needs a bucket + Object Storage credentials).
- A CI apply job — see #18 (deploy job) and `docs/conventions.md` → Infra.
- Cluster bootstrap (ingress-nginx, cert-manager, sealed-secrets, monitoring,
  Loki, OTel) — #16.

## Where to run apply

For now, `terraform plan`/`apply` run from the Hermes VPS (`trentcyber-main`), which holds `HCLOUD_TOKEN` in its env and the SSH key the provisioners use. State is local to that clone (`terraform.tfstate`, git-ignored) until the Object Storage backend lands. CI runs `fmt -check` and `validate` only; it never applies this root (ADR-0001, AI-GOVERNANCE: agents do not apply infra).

Applied 2026-09-07: server `frontdesk` in nbg1, floating IP 167.233.178.242, k3s v1.36.4+k3s1. Kubeconfig at `infra/hetzner/kubeconfig` on the VPS (git-ignored).
