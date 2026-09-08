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

## Tailscale (manual join + rebuild parity)

ADR-0010 anticipated this: admin access moves from an IP allowlist to the
tailnet. The **live node is joined by hand**, not by re-running Terraform —
`hcloud_server.frontdesk` has `ignore_changes = [user_data]`, so changing
`cloud-init.yaml.tftpl` never touches the running box. Terraform's role here
is rebuild parity only: if the node is ever recreated from scratch, the
`tailscale_auth_key` / `tailscale_ip` variables and the cloud-init changes
make the new box join the tailnet and get the right k3s TLS SAN
automatically, without a second manual pass.

**A rebuild mints a new tailnet identity.** `tailscale up` on a fresh box
joins as a new node (`frontdesk-1`, a new `100.x` address), not a rejoin of
the old one — Tailscale keys off the machine's local state
(`/var/lib/tailscale/tailscaled.state`), which a rebuild does not carry
over. Before rebuilding, delete the old `frontdesk` machine in the
Tailscale admin console so it doesn't linger as a stale, unreachable node;
after the new node joins, update `tailscale_ip` in `terraform.tfvars` to
its reported address (`tailscale ip -4` on the box, or the admin console)
before the follow-up `terraform apply` that adds the extra k3s TLS SAN.

**Tagged key, not a user key.** The auth key is minted under
`tag:frontdesk-node` (reusable, 90-day expiry). Tagged nodes have no *node*
key expiry, so once joined the node does not silently drop off the tailnet
when the key lapses. `tailscaled` is a systemd unit enabled by the apt
package, and its state lives in `/var/lib/tailscale/tailscaled.state`, so a
reboot rejoins without a key.

`tailscale up` runs with `--accept-dns=false`: MagicDNS would rewrite
`/etc/resolv.conf` to `100.100.100.100`, and CoreDNS forwards to the node's
resolv.conf, so cluster DNS would start depending on `tailscaled` being up.
Tailscale SSH stays off — plain SSH over the tailnet is enough, and it avoids
a second ACL surface.

The Hetzner firewall's `22`/`6443` rules stay as a break-glass path
(`vps_ip`, and `admin_ips` if non-empty); they are not how normal tailnet
traffic reaches the node. Tailscale's WireGuard packets land on `udp/41641`
on the public interface, get decrypted, and reappear on the `tailscale0`
interface, which the Hetzner Cloud firewall (applied to the public NIC) does
not re-filter — so SSH/6443 over the tailnet is gated by the Tailscale ACL
below, not by this firewall.

### 1. Tailscale admin console

Access Controls -> merge into the existing policy JSON:

```json
"tagOwners": { "tag:frontdesk-node": ["autogroup:admin"] },
"acls": [
  { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:frontdesk-node:22,6443"] }
]
```

If the policy is still the default allow-all `acls`, only `tagOwners` is
needed.

Settings -> Keys -> Generate auth key: Reusable, Expiration 90 days, Tags
`tag:frontdesk-node`. Put it in `terraform.tfvars` as
`tailscale_auth_key = "tskey-auth-..."` (git-ignored, `chmod 600`) — this is
only consumed if the node is ever rebuilt; it does not touch the live box.

### 2. Join the live node, from the VPS

```bash
ssh -i ~/.ssh/frontdesk-node root@167.233.178.242
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key='tskey-auth-...' --hostname=frontdesk --accept-dns=false
tailscale ip -4                      # note this; it is $TS_IP below
systemctl is-enabled tailscaled      # must print: enabled

# Add the tailnet IP as a k3s TLS SAN. config.yaml would be overridden by the
# unit's CLI flags, so re-run the installer with the same flags plus one
# more; it rewrites the systemd unit idempotently.
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.36.4+k3s1" \
  INSTALL_K3S_EXEC="server --disable traefik --disable servicelb --tls-san 167.233.178.242 --tls-san $TS_IP --node-external-ip 167.233.178.242" sh -
sleep 20; kubectl get nodes
echo | openssl s_client -connect 127.0.0.1:6443 2>/dev/null | openssl x509 -noout -ext subjectAltName | grep -o "IP Address:[0-9.]*"
# if $TS_IP is missing from the SAN list: kubectl -n kube-system delete secret k3s-serving && systemctl restart k3s, re-check
reboot
```

### 3. Verify, from the VPS (after ~60s)

```bash
tailscale status | grep frontdesk           # node present, not "offline"
tailscale ping frontdesk                    # expect "pong ... via <ip>:41641" (direct), not "via DERP"
ssh -i ~/.ssh/frontdesk-node root@$TS_IP 'systemctl is-active tailscaled k3s; kubectl get nodes'
cd ~/code/frontdesk-intake/infra/hetzner
kubectl --kubeconfig kubeconfig config set-cluster frontdesk-ts --server=https://$TS_IP:6443 --certificate-authority=<(kubectl --kubeconfig kubeconfig config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d) --embed-certs
kubectl --kubeconfig kubeconfig config set-context frontdesk-ts --cluster=frontdesk-ts --user=default
kubectl --kubeconfig kubeconfig --context frontdesk-ts get nodes       # works over the tailnet
```

The default kubeconfig context (floating IP) keeps working; `frontdesk-ts` is
an additional context for the tailnet path.

### 4. Lock down the firewall

Once the tailnet path is verified, set `tailscale_ip = "$TS_IP"` and
`admin_ips = []` in `terraform.tfvars`, then:

```bash
terraform plan     # expect: 1 firewall in-place update, 0 server changes
terraform apply
```

Confirm from a non-VPS host: `ssh root@167.233.178.242` now times out (the
public-IP allowlist is empty) and `ssh root@$TS_IP` works.

## Not yet here

- Remote state backend — deliberately not (ADR-0012); revisit with the CI apply job.
- A CI apply job — see #18 (deploy job) and `docs/conventions.md` → Infra.
- Cluster bootstrap (ingress-nginx, cert-manager, sealed-secrets, monitoring,
  Loki, OTel) — #16.

## Where to run apply

For now, `terraform plan`/`apply` run from the Hermes VPS (`trentcyber-main`), which holds `HCLOUD_TOKEN` in its env and the SSH key the provisioners use. State is local to that clone (`terraform.tfstate`, git-ignored) until the Object Storage backend lands. CI runs `fmt -check` and `validate` only; it never applies this root (ADR-0001, AI-GOVERNANCE: agents do not apply infra).

Applied 2026-09-07: server `frontdesk` in nbg1, floating IP 167.233.178.242, k3s v1.36.4+k3s1. Kubeconfig at `infra/hetzner/kubeconfig` on the VPS (git-ignored).
