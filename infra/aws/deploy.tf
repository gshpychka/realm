data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = [
      "sts:AssumeRole",
      # Roles Anywhere tags the session with the certificate's fields and sets
      # its source identity to the subject's CN
      "sts:TagSession",
      "sts:SetSourceIdentity",
    ]
    principals {
      type        = "Service"
      identifiers = ["rolesanywhere.amazonaws.com"]
    }
    # the certificate chains to reaper's CA
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_rolesanywhere_trust_anchor.reaper.arn]
    }
    # reaper's certificate for my user, "<hostname>:<user>"
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalTag/x509Subject/CN"
      values   = ["reaper:${var.user}"]
    }
  }
}

# Deploys every stack in this account, this unit included.
resource "aws_iam_role" "deploy" {
  name               = "deploy"
  description        = "Deploys the stacks in this account"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

# The stacks and this unit create IAM roles, which amounts to administrator access.
resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
