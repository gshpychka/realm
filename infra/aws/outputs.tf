data "aws_region" "current" {}

output "aws_config" {
  description = "The infra shell's default AWS profile, for infra/.home/.aws/config"
  value       = <<-EOF
    [default]
    region = ${data.aws_region.current.region}
    credential_process = rolesanywhere-credentials --trust-anchor-arn ${aws_rolesanywhere_trust_anchor.reaper.arn} --profile-arn ${aws_rolesanywhere_profile.deploy.arn} --role-arn ${aws_iam_role.deploy.arn}
  EOF
}
