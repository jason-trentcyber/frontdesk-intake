output "server_ipv4" {
  description = "The server's own public IPv4 (not the floating IP)."
  value       = hcloud_server.frontdesk.ipv4_address
}

output "floating_ip" {
  description = "Floating IP. Point frontdesk.jtrent.dev's DNS at this (ADR-0002)."
  value       = hcloud_floating_ip.frontdesk.ip_address
}

output "kubeconfig_path" {
  description = "Local path to the kubeconfig fetched from the server, rewritten to the floating IP."
  value       = "${path.module}/kubeconfig"
}
