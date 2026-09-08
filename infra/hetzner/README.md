# infra/hetzner

Terraform root that provisions the single Hetzner Cloud box the whole stack
runs on (ADR-0001): one cx23 (x86, 2 vCPU / 4 GB; ADR-0010)
cloud-init that turns the box into a one-node k3s cluster with Traefik and
servicelb disabled (ingress-nginx replaces Traefik, per ADR-0002).

## State

Local state (`terraform.tfstate` in this directory, git-ignored), by decision
(ADR-0012): one operator, one shell, no CI apply job, and nothing sensitive in
the file. A remote backend gets its own ADR when the first CI apply job or a
second operator arrives.

**After every `apply`, copy the state off-host.** From your workstation (not
the VPS):

```
mkdir -p ~/backups/frontdesk-tfstate
scp trentcyber:code/frontdesk-intake/infra/hetzner/terraform.tfstate \
  ~/backups/frontdesk-tfstate/terraform.tfstate.$(date +%FT%H%M%S)
```

A same-host copy also lives at `~/backups/frontdesk-hetzner-tfstate/` on the
VPS; it guards against an in-place mistake, not against losing the host.

**Recovery if the VPS is lost and no copy exists.** Everything in this root
has a stable Hetzner ID and can be re-adopted:

```
cd infra/hetzner
terraform init
terraform import hcloud_ssh_key.admin                    118483504
terraform import 'hcloud_ssh_key.extra["jason-nucbox"]'  118483503
terraform import hcloud_firewall.frontdesk               11588996
terraform import hcloud_floating_ip.frontdesk            148530476
terraform import hcloud_server.frontdesk                 165032630
terraform import hcloud_floating_ip_assignment.frontdesk 148530476
terraform plan
```

Tested 2026-09-08 against the live account from a scratch copy of this root
with an empty state: all six imports succeed and `plan` reports exactly
`2 to add, 0 to change, 0 to destroy` — the two `null_resource` provisioner
anchors, which re-run `cloud-init status --wait` and refetch the kubeconfig
(harmless). Anything else in the plan means an import went to the wrong ID:
stop and check the console before applying.

The `lifecycle.ignore_changes` on `hcloud_server` for `ssh_keys` and
`user_data` is what makes that plan clean; without it an imported server
plans a replacement (no `user_data` hash comes back from the API, and the
key list is in API order). See the comment in `main.tf`.

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

- Remote state backend — deliberately not (ADR-0012); revisit with the CI apply job.
- A CI apply job — see #18 (deploy job) and `docs/conventions.md` → Infra.
- Cluster bootstrap (ingress-nginx, cert-manager, sealed-secrets, monitoring,
  Loki, OTel) — #16.

## Where to run apply

For now, `terraform plan`/`apply` run from the Hermes VPS (`trentcyber-main`), which holds `HCLOUD_TOKEN` in its env and the SSH key the provisioners use. State is local to that clone (`terraform.tfstate`, git-ignored) until the Object Storage backend lands. CI runs `fmt -check` and `validate` only; it never applies this root (ADR-0001, AI-GOVERNANCE: agents do not apply infra).

Applied 2026-09-07: server `frontdesk` in nbg1, floating IP 167.233.178.242, k3s v1.36.4+k3s1. Kubeconfig at `infra/hetzner/kubeconfig` on the VPS (git-ignored).
