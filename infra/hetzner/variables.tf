variable "server_name" {
  description = "Name for the Hetzner server, floating IP, firewall, and SSH key."
  type        = string
  default     = "frontdesk"
}

variable "server_type" {
  description = "Hetzner server type. ADR-0001 amendment 2026-09-07: cax21 (Ampere ARM64, 4 vCPU / 8 GB). cx32 is discontinued and cx33 was out of stock everywhere."
  type        = string
  default     = "cax21"
}

variable "image" {
  description = "Hetzner OS image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "location" {
  description = "Hetzner datacenter location. nbg1 and hel1 had cax21 stock on 2026-09-07; fsn1 did not."
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
