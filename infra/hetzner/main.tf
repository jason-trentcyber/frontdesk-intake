# Cloudflare's published edge ranges (docs/adr/0002): 80/443 are reachable
# only from these, so the origin can't be hit by skipping the CDN/WAF.
data "http" "cloudflare_ipv4" {
  url = "https://www.cloudflare.com/ips-v4"
}

data "http" "cloudflare_ipv6" {
  url = "https://www.cloudflare.com/ips-v6"
}

locals {
  cloudflare_cidrs = concat(
    compact(split("\n", trimspace(data.http.cloudflare_ipv4.response_body))),
    compact(split("\n", trimspace(data.http.cloudflare_ipv6.response_body))),
  )
  ssh_source_ips = concat(var.admin_ips, [var.vps_ip])
}

resource "hcloud_ssh_key" "admin" {
  name       = "${var.server_name}-admin"
  public_key = var.ssh_public_key
}

# Extra human admin keys (Jason's laptop). The deploy key above is what
# Terraform's provisioners use; these are for interactive access.
resource "hcloud_ssh_key" "extra" {
  for_each   = var.extra_ssh_public_keys
  name       = "${var.server_name}-${each.key}"
  public_key = each.value
}

resource "hcloud_firewall" "frontdesk" {
  name = "${var.server_name}-fw"

  rule {
    description = "SSH from Jason's IPs and the Hermes VPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = local.ssh_source_ips
  }

  rule {
    description = "HTTP from Cloudflare only"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = local.cloudflare_cidrs
  }

  rule {
    description = "HTTPS from Cloudflare only"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = local.cloudflare_cidrs
  }
}

# Reserved ahead of the server so cloud-init can bake it into the k3s TLS SAN
# and node external IP in the same apply.
resource "hcloud_floating_ip" "frontdesk" {
  type          = "ipv4"
  home_location = var.location
  description   = "${var.server_name} k3s API + ingress"
}

resource "hcloud_server" "frontdesk" {
  name         = var.server_name
  server_type  = var.server_type
  image        = var.image
  location     = var.location
  ssh_keys     = concat([hcloud_ssh_key.admin.id], [for k in hcloud_ssh_key.extra : k.id])
  firewall_ids = [hcloud_firewall.frontdesk.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    floating_ip = hcloud_floating_ip.frontdesk.ip_address
    k3s_version = var.k3s_version
  })
}

resource "hcloud_floating_ip_assignment" "frontdesk" {
  floating_ip_id = hcloud_floating_ip.frontdesk.id
  server_id      = hcloud_server.frontdesk.id
}

# cloud-init finishes k3s install asynchronously after boot; block until it's
# actually done before anything tries to read the kubeconfig off the box.
resource "null_resource" "wait_for_cloud_init" {
  depends_on = [hcloud_floating_ip_assignment.frontdesk]

  connection {
    type        = "ssh"
    host        = hcloud_server.frontdesk.ipv4_address
    user        = "root"
    private_key = file(var.ssh_private_key_path)
    timeout     = "5m"
  }

  provisioner "remote-exec" {
    inline = ["cloud-init status --wait"]
  }
}

# k3s writes its kubeconfig pointed at 127.0.0.1; rewrite it to the floating
# IP so it works from off-box (the acceptance bar in #15).
resource "null_resource" "fetch_kubeconfig" {
  depends_on = [null_resource.wait_for_cloud_init]

  triggers = {
    server_id = hcloud_server.frontdesk.id
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      ssh -o StrictHostKeyChecking=accept-new -i ${var.ssh_private_key_path} \
        root@${hcloud_server.frontdesk.ipv4_address} cat /etc/rancher/k3s/k3s.yaml \
        | sed 's/127.0.0.1/${hcloud_floating_ip.frontdesk.ip_address}/' \
        > ${path.module}/kubeconfig
      chmod 600 ${path.module}/kubeconfig
    EOT
  }
}
