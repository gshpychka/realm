# ProbaBench infrastructure

The [Alchemy AWS static-site resource](https://alchemy.run/aws/frontend/static-site/)
builds `../packages/web`, uploads its `dist/` to a private S3 bucket, and serves it
over HTTPS through CloudFront. The stack returns the public URL. Benchmark
results are static files in the release; running a benchmark does not update the
hosted site until the next deployment.

This workspace uses Alchemy 2 and Effect 4, matching `infra/link-sanitizer`.
Keeping these dependencies here lets the benchmark and frontend use their own
Effect version.

From the repository root, enter `nix develop .#infra`, then:

```sh
cd infra/probabench
bun install --frozen-lockfile

# Once per AWS account: use the shared Alchemy profile and assets bucket.
# Skip these steps if link-sanitizer already configured them.
cd infra
bun alchemy profile edit --add AWS
bun alchemy provider aws bootstrap --aws-profile <profile-name>

bun run plan
bun run deploy
```

Choose an AWS profile configured by the infra shell, and authenticate with
`aws sso login --profile <profile-name>` when that profile uses SSO. Deployments
use the `prod` stage and require AWS credentials. The stack creates billable AWS
resources; `bun run destroy` removes that stage and its generated site assets.
It does not delete the shared Alchemy bootstrap bucket.

`bun run dev` in this workspace runs Alchemy with Vite's local development
server and needs Docker for Alchemy's AWS emulator. It uses local state and
does not require AWS credentials. From the ProbaBench root, `bun run dev` starts
Vite directly without Docker. Neither command needs a cloud deployment.

Deployments invalidate CloudFront and wait for completion. HTML uses Alchemy's
default revalidation policy; result JSON also revalidates, while Vite's hashed
JavaScript and CSS retain their immutable cache headers.

`patches/` carries the same
[AWS SSO configuration fix](https://github.com/alchemy-run/distilled/pull/650)
as link-sanitizer. It makes the pinned AWS client honor `AWS_CONFIG_FILE`, which
the infra shell sets to the repository's isolated AWS profiles. The workspace
root applies the patch through `patchedDependencies`.
