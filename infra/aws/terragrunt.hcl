include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  reaper_ca_certificate = file("${get_repo_root()}/machines/reaper/rolesanywhere-ca.pem")
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    terraform {
      required_version = ">= 1.0"
      required_providers {
        aws = {
          source  = "hashicorp/aws"
          version = "~> 6.0"
        }
      }
    }

    provider "aws" {
      # Roles Anywhere is regional: the trust anchor and the profile live here,
      # and aws_signing_helper finds the region in the trust anchor's ARN
      region              = "eu-west-1"
      allowed_account_ids = [var.aws_account_id]
    }
  EOF
}
