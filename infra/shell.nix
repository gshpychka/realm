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
    p.hashicorp_aws
  ]);
  # sops exec-env takes one command string, which a shell re-parses, so each
  # argument is requoted with bash's ${*@Q}, which, unlike printf %q, expands to
  # nothing when there are no arguments
  sopsExecEnv =
    name: envFile: command:
    pkgs.writeShellScriptBin name ''
      ${lib.getExe pkgs.sops} exec-env "$REPO_ROOT/secrets/infra/${envFile}" \
        "${command} ''${*@Q}"
    '';
  # The Alchemy CLI with the current AWS CLI profile's credentials: Alchemy reads
  # AWS credentials from the environment or its own profiles alone
  alchemyAws = pkgs.writeShellApplication {
    name = "alchemy-aws";
    runtimeInputs = [
      pkgs.awscli2
      pkgs.bun
    ];
    text = ''
      # the profile's credentials, as export lines
      credentials=$(aws configure export-credentials --format env)
      # puts them in this environment
      eval "$credentials"
      # the profile's region, unless AWS_REGION names one
      AWS_REGION=''${AWS_REGION:-$(aws configure get region)}
      # puts the region in this environment
      export AWS_REGION
      # runs this directory's Alchemy CLI with both
      exec bun alchemy "$@"
    '';
  };
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
    (sopsExecEnv "tf" "terraform.env" (lib.getExe terraform))
    (sopsExecEnv "tg" "terraform.env" (lib.getExe pkgs.terragrunt))
    alchemyAws
    # the ProbaBench CLI with its OpenRouter key; it finds its history file from its
    # own path, so it runs from any directory
    (sopsExecEnv "probabench" "probabench.env"
      "${lib.getExe pkgs.bun} $REPO_ROOT/infra/probabench/packages/runner/src/main.ts"
    )
  ];
  shellHook = ''
    export REPO_ROOT=$(git rev-parse --show-toplevel)
    export CLOUDSDK_CONFIG=$REPO_ROOT/infra/.home/.config/gcloud
    export GOOGLE_APPLICATION_CREDENTIALS=$CLOUDSDK_CONFIG/application_default_credentials.json
    export CLOUDSDK_CORE_PROJECT="${values.gcpProjectId}"
    export TF_VAR_gcp_project_id="${values.gcpProjectId}"
    export TF_VAR_domain_name="${values.domain}"
    export TF_VAR_user="${values.user}"
    export DOMAIN_NAME="${values.domain}"
    export TF_STATE_BUCKET="${values.gcpTfStateBucket}"
    # Alchemy and AWS profiles live under infra/.home, apart from any others
    # on the machine. The default AWS profile is infra/aws's aws_config output.
    # The AWS CLI keeps its SSO token cache in ~/.aws/sso/cache, so the SSO
    # session needs a name no other config uses.
    export ALCHEMY_HOME=$REPO_ROOT/infra/.home/.alchemy
    export AWS_CONFIG_FILE=$REPO_ROOT/infra/.home/.aws/config
    export AWS_SHARED_CREDENTIALS_FILE=$REPO_ROOT/infra/.home/.aws/credentials
    # the alchemy CLI exports its traces, metrics and logs to otel.alchemy.run unless set
    export ALCHEMY_TELEMETRY_DISABLED=1
  '';
}
