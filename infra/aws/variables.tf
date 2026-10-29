variable "aws_account_id" {
  description = "The AWS account this unit manages"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "user" {
  description = "My user on reaper"
  type        = string
}

variable "reaper_ca_certificate" {
  description = "reaper's Roles Anywhere CA certificate (PEM)"
  type        = string

  validation {
    condition     = can(regex("^-----BEGIN CERTIFICATE-----", var.reaper_ca_certificate))
    error_message = "reaper_ca_certificate must be a PEM certificate."
  }
}
