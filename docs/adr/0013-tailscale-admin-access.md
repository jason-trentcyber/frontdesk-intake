# ADR-0013: Admin access to the k3s node moves to the tailnet; public 22/6443 kept as break-glass

Status: decided 2026-09-08, applied (PR #58, issue #57). Refines ADR-0010 ("until Tailscale replaces the IP allowlist"); does not amend it.

## Context
ADR-0010 opened SSH (22) and the Kubernetes API (6443) on the Hetzner firewall to two public sources: the Hermes VPS and Jason's home IP. The home IP is dynamic and had to be edited into `terraform.tfvars` by hand; the CI deploy job (#18) was to reach the cluster "via the VPS" for the same reason. ADR-0010 said Tailscale would replace this. This ADR records how, since the review agent on PR #58 correctly noted that the specific decisions (key model, ACL shape, what stays public, how a rebuild rejoins) were not written down anywhere an agent would read before touching `infra/hetzner`.

Facts at decision time: the tailnet already held the VPS, the NucBox and the MacBook. The node was k3s v1.36.4 on Ubuntu 24.04 with all k3s flags baked into the systemd unit (no `config.yaml`). `hcloud_server` carries `lifecycle.ignore_changes = [user_data]` (ADR-0012), so a cloud-init change cannot reach the running box.

## Decision
- **Live node joined by hand; Terraform gets rebuild parity only.** The join, the extra k3s TLS SAN and a reboot test were run once from the VPS following the runbook in `infra/hetzner/README.md`. `cloud-init.yaml.tftpl` gained the same steps so a from-scratch rebuild lands in the same state. The server was not replaced to "do it through Terraform".
- **Tagged, reusable auth key** (`tag:frontdesk-node`, 90-day key expiry) rather than a user-owned key. Tagged nodes have no node-key expiry, so the joined node cannot silently fall off the tailnet later. `tagOwners` grants the tag to `autogroup:admin`; the ACL admits members to `tag:frontdesk-node:22,6443`. Exporter ports are added by #52 when there is something to scrape.
- **Firewall:** `admin_ips` is `[]`. 22 and 6443 stay open to the VPS's public IP as the break-glass path when the tailnet is down. `udp/41641` is open to `0.0.0.0/0` and `::/0` so peers get a direct WireGuard path instead of a DERP relay; Tailscale's own guidance is that this port cannot be usefully source-restricted because peer addresses are not known in advance (https://tailscale.com/kb/1082/firewall-ports). WireGuard authenticates every packet by key, so an open UDP port admits nothing that is not already a tailnet peer.
- **k3s serving cert carries the tailnet IP** (`100.88.28.10`) as a SAN; the kubeconfig keeps the floating IP as the default context and adds `frontdesk-ts` for the tailnet path.
- **`--accept-dns=false`.** MagicDNS would point the node's `resolv.conf` at `100.100.100.100`; CoreDNS forwards to that file, so cluster DNS would depend on `tailscaled`. Tailscale SSH stays off: plain SSH over the tailnet is enough and avoids a second ACL surface.
- **Accepted residual risk: the auth key is plaintext in Hetzner `user_data`.** `sensitive = true` hides it from Terraform output, not from the Hetzner API. Mitigations: the key only mints a node carrying `tag:frontdesk-node` (it cannot create a user device or widen the ACL), it expires in 90 days, and it is revocable from the admin console. Fetching it from a secrets store at boot would add a service for one key; not warranted. If the Hetzner project ever gains a second operator, rotate the key and revisit.

## Consequences
- Home-IP churn no longer touches Terraform. The only public admin path is the VPS IP.
- Verified 2026-09-08: `tailscale ping` direct via `:41641` after the firewall change (DERP before it); `kubectl --context frontdesk-ts get nodes` Ready; SSH to the floating IP from the NucBox times out, SSH to the tailnet IP works; node rebooted with tailscaled, k3s and CoreDNS healthy; post-apply `terraform plan` = No changes.
- A rebuild mints a new tailnet identity (`frontdesk-1`, new 100.x address). The README says to delete the old machine in the admin console first and to update `tailscale_ip` afterwards; the SAN in `cloud-init` uses `$(tailscale ip -4)` at boot so it is right even before `tailscale_ip` is updated.
- The tailnet is now a dependency for normal admin work. The break-glass path exists precisely so it is not a dependency for emergency work.
- #52 (VPS-side observability) can scrape over the tailnet without further firewall change.

## Rejected
- **Tailnet-only, close 22/6443 to the VPS as well.** Removes the last non-Tailscale path; a tailnet outage or an expired ACL change would lock out the cluster. The VPS IP is static and already trusted.
- **User-owned auth key.** Simpler to mint; node key expires with the user's and the node drops off the tailnet at the worst time.
- **Replace the server so Terraform performs the join.** Throws away a healthy node for purity; `ignore_changes` on `user_data` exists for exactly this reason (ADR-0012).
- **Tailscale SSH.** Convenient, but it makes the Tailscale ACL an SSH authorisation layer on top of `authorized_keys`; one mechanism is enough at this size.
- **Secrets store for the auth key at boot.** New service, new credential, to protect a tag-scoped 90-day key. Recorded as the residual risk instead.
