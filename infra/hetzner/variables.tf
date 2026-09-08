variable "server_name" {
  description = "Name for the Hetzner server, floating IP, firewall, and SSH key."
  type        = string
  default     = "frontdesk"
}

variable "server_type" {
  description = "Hetzner server type. ADR-0010: cx23 (x86, 2 vCPU / 4 GB); observability runs off-node on the Hermes VPS."
  type        = string
  default     = "cx23"
}

variable "image" {
  description = "Hetzner OS image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "location" {
  description = "Hetzner datacenter location. nbg1 chosen 2026-09-07 (ADR-0010)."
  type        = string
  default     = "nbg1"
}

variable "ssh_public_key" {
  description = "Public key (e.g. contents of ~/.ssh/id_ed25519.pub) installed on the server for root SSH access."
  type        = string
}

variable "ssh_private_key_path" {
  description = "Path to the private key matching ssh_public_key. Used by Terraform to wait for cloud-init and fetch the kubeconfig; never committed."
  type        = string
  default     = "~/.ssh/id_ed25519"
}

variable "admin_ips" {
  description = "CIDRs allowed SSH (port 22) to the server. Jason's IP(s)."
  type        = list(string)
}

variable "vps_ip" {
  description = "CIDR (single IP as /32) of the Hermes VPS, allowed SSH to the server."
  type        = string
}

variable "k3s_version" {
  description = "k3s channel/version to pin (e.g. v1.31.4+k3s1). Empty string installs the current stable release."
  type        = string
  default     = ""
}

variable "extra_ssh_public_keys" {
  description = "Additional public keys for interactive root SSH, keyed by a short name (e.g. jason-laptop). The deploy key in ssh_public_key is what Terraform itself uses."
  type        = map(string)
  default     = {}
}

variable "tailscale_auth_key" {
  description = "Reusable, tagged (tag:frontdesk-node) Tailscale auth key. cloud-init uses it to join the tailnet on first boot; empty string skips the join entirely. Sensitive; set only in terraform.tfvars (ADR-0010)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "tailscale_ip" {
  description = "Node's tailnet IPv4, filled in after the first manual join. Used only to add an extra k3s TLS SAN on rebuild; the live node is joined by hand, not by cloud-init (ADR-0010)."
  type        = string
  default     = ""
}
