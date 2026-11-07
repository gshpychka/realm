resource "cloudflare_dns_record" "home" {
  zone_id = var.cloudflare_zone_id
  name    = "home.${var.domain_name}"
  type    = "CNAME"
  content = "n8ovrmnzr5a0rt9rwxmddfsakrsgoms9.ui.nabu.casa"
  proxied = false
  ttl     = 1
  comment = "Home Assistant Cloud (Nabu Casa)"
}

resource "cloudflare_dns_record" "home-acme" {
  zone_id = var.cloudflare_zone_id
  name    = "_acme-challenge.home.${var.domain_name}"
  type    = "CNAME"
  content = "_acme-challenge.n8ovrmnzr5a0rt9rwxmddfsakrsgoms9.ui.nabu.casa"
  proxied = false
  ttl     = 1
  comment = "ACME DNS-01 delegation for home (Nabu Casa)"
}

resource "cloudflare_dns_record" "mx_send" {
  zone_id  = var.cloudflare_zone_id
  name     = "send.${var.domain_name}"
  type     = "MX"
  content  = "feedback-smtp.eu-west-1.amazonses.com"
  priority = 10
  proxied  = false
  ttl      = 3600
  comment  = "Outbound return-path - Resend (Amazon SES)"
}

resource "cloudflare_dns_record" "dkim_resend" {
  zone_id = var.cloudflare_zone_id
  name    = "resend._domainkey.${var.domain_name}"
  type    = "TXT"
  content = "\"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCoWrNC8YRa0Nh+7UHUXSzu7Bpd5r5TN5YTH+JhDI+c9N8GQN52sZCbZ+AzNV0MErhPHS0yJAhSCqRfHGjcZgSuxbtkAAOFBK3gOFGd8tAcffjTBpIUzgb84U5kGwSSveCwZOEL8Noy3JHBoFND3wgzGtYsnoFzQJWXIy16mJeLtwIDAQAB\""
  proxied = false
  ttl     = 3600
  comment = "Outbound DKIM - Resend"
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  content = "\"v=DMARC1; p=quarantine; sp=reject; rua=mailto:4e10db4bed69489faa4ec65e68121228@dmarc-reports.cloudflare.net\""
  proxied = false
  ttl     = 1
  comment = "DMARC policy"
}

resource "cloudflare_dns_record" "spf_send" {
  zone_id = var.cloudflare_zone_id
  name    = "send.${var.domain_name}"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com -all\""
  proxied = false
  ttl     = 3600
  comment = "Outbound SPF - Resend (Amazon SES)"
}

# inbound mail
resource "cloudflare_email_routing_dns" "this" {
  zone_id = var.cloudflare_zone_id
}

resource "cloudflare_dns_record" "wan" {
  zone_id = var.cloudflare_zone_id
  name    = "wan.${var.domain_name}"
  type    = "A"
  # RFC 5737 documentation address, in place only until the DDNS client's first update
  content = "192.0.2.1"
  proxied = false
  # Cloudflare's minimum for unproxied records outside Enterprise plans
  ttl     = 60
  comment = "Home WAN address, kept current by harbor's DDNS client"

  lifecycle {
    # the DDNS client owns the address
    ignore_changes = [content]
  }
}
