# infra/hetzner

Terraform root that provisions the single Hetzner Cloud box the whole stack
runs on (ADR-0001): one CX32 server, a firewall, a floating IP, and a
cloud-init that turns the box into a one-node k3s cluster with Traefik and
servicelb disabled (ingress-nginx replaces Traefik, per ADR-0002).

## State

Local state (`terraform.tfstate` in this directory, git-ignored) for now —
there's one operator and one environment, and a remote backend is one more
thing to provision before there's anything to provision it for.

Move to a remote backend before a second person or a CI apply job touches
this root: Hetzner Object Storage (S3-compatible) via the `s3` backend
(`endpoints.s3 = "https://<region>.your-objectstorage.com"`,
`skip_credentials_validation`/`skip_region_validation`/`skip_requesting_account_id`
= true, since it isn't AWS). Until then, only run `apply`/`destroy` from one
place and keep `terraform.tfstate*` backed up.

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

- Remote state backend (see above).
- A CI apply job — see #18 (deploy job) and `docs/conventions.md` → Infra.
- Cluster bootstrap (ingress-nginx, cert-manager, sealed-secrets, monitoring,
  Loki, OTel) — #16.
