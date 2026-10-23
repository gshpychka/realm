{
  nixpkgs,
  system,
  bun2nix,
}:
let
  pkgs = import nixpkgs {
    inherit system;
    config.allowUnfree = true;
  };
  inherit (pkgs) lib;
  values = import ../modules/common/values.nix;

  # tf providers managed by nix
  terraform = pkgs.terraform.withPlugins (p: [
    p.cloudflare_cloudflare
    p.hashicorp_google
    p.clementblaise_age
    p.tailscale_tailscale
  ]);
  # sops exec-env takes one command string, which a shell re-parses, so each
  # argument is requoted with printf %q
  sopsExecEnv =
    name: package:
    pkgs.writeShellScriptBin name ''
      ${lib.getExe pkgs.sops} exec-env "$REPO_ROOT/secrets/infra/terraform.env" \
        "${lib.getExe package} $(printf '%q ' "$@")"
    '';
in
pkgs.mkShell {
  buildInputs = [
    terraform
    pkgs.google-cloud-sdk
    pkgs.awscli2
    pkgs.bun
    # probabench: the vite, vitest and tsc bins run under #!/usr/bin/env node
    pkgs.nodejs
    bun2nix.packages.${system}.default
    pkgs.sops
    pkgs.age
    pkgs.terragrunt
    (sopsExecEnv "tf" terraform)
    (sopsExecEnv "tg" pkgs.terragrunt)
  ];
  shellHook = ''
    export REPO_ROOT=$(git rev-parse --show-toplevel)
    export CLOUDSDK_CONFIG=$REPO_ROOT/infra/.home/.config/gcloud
    export GOOGLE_APPLICATION_CREDENTIALS=$CLOUDSDK_CONFIG/application_default_credentials.json
    export CLOUDSDK_CORE_PROJECT="${values.gcpProjectId}"
    export TF_VAR_gcp_project_id="${values.gcpProjectId}"
    export TF_VAR_domain_name="${values.domain}"
    export TF_STATE_BUCKET="${values.gcpTfStateBucket}"
    # Alchemy and AWS profiles live under infra/.home, apart from any others
    # on the machine. The AWS CLI keeps its SSO token cache in ~/.aws/sso/cache,
    # so the SSO session needs a name no other config uses.
    export ALCHEMY_HOME=$REPO_ROOT/infra/.home/.alchemy
    export AWS_CONFIG_FILE=$REPO_ROOT/infra/.home/.aws/config
    export AWS_SHARED_CREDENTIALS_FILE=$REPO_ROOT/infra/.home/.aws/credentials
    # the alchemy CLI exports its traces, metrics and logs to otel.alchemy.run unless set
    export ALCHEMY_TELEMETRY_DISABLED=1
  '';
}
