data "tailscale_devices" "all" {}

locals {
  # Keyed by machine name
  device = { for d in data.tailscale_devices.all.devices : split(".", d.name)[0] => d }

  # machines whose node keys stay valid indefinitely.
  non_expiring = ["harbor", "reaper", "hoard"]
}

resource "tailscale_device_key" "non_expiring" {
  for_each            = toset(local.non_expiring)
  device_id           = local.device[each.key].node_id
  key_expiry_disabled = true
}

# Approved routes: exit node plus the home LAN.
resource "tailscale_device_subnet_routes" "harbor" {
  device_id = local.device["harbor"].node_id
  routes = [
    "0.0.0.0/0",
    "::/0",
    "192.168.1.0/24",
  ]
}
