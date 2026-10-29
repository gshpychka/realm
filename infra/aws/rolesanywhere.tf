# reaper's CA (services.rolesanywhere). A new CA certificate updates the trust anchor in place.
resource "aws_rolesanywhere_trust_anchor" "reaper" {
  name    = "reaper"
  enabled = true

  source {
    source_type = "CERTIFICATE_BUNDLE"
    source_data {
      x509_certificate_data = var.reaper_ca_certificate
    }
  }
}

# The roles a trusted certificate may assume.
resource "aws_rolesanywhere_profile" "deploy" {
  name      = "deploy"
  enabled   = true
  role_arns = [aws_iam_role.deploy.arn]
}
