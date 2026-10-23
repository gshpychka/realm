import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The apex domain from modules/common/values.nix, exported by the infra shell. */
const DomainName = Config.NonEmptyString("DOMAIN_NAME");

export default Alchemy.Stack(
  "ProbaBench",
  {
    providers: Cloudflare.providers(),
    // Alchemy's AWS state store resolves real credentials even in dev mode.
    // Keep local development independent of the account's remote state.
    state: Layer.unwrap(
      Alchemy.AlchemyContext.useSync(({ dev }) => (dev ? Alchemy.localState() : AWS.state())),
    ),
  },
  Effect.gen(function* () {
    // Without `main` the Worker is assets-only: every request, the SPA fallback
    // included, is a static-asset request, which Cloudflare serves for free and
    // outside the Workers request quota.
    const site = yield* Cloudflare.Website.StaticSite("Web", {
      cwd: "../web",
      command: "bun run build",
      outdir: "dist",
      // Vite imports the domain workspace directly. Include it in the build
      // hash so schema-only changes cannot reuse an outdated frontend build.
      // The history sits outside packages/web too, so it is named here, or a
      // data-only change would reuse an outdated build. An explicit include
      // leaves bun.lock out of the hash unless lockfile is set.
      memo: {
        include: [
          "**/*",
          "../domain/src/**",
          "../domain/package.json",
          "../../data/results.json",
          "../../tsconfig.base.json",
          "../../package.json",
        ],
        lockfile: true,
      },
      // Under `alchemy dev` this replaces the build, and the Worker stays a
      // local stub: nothing is deployed and the zone is never read.
      dev: { command: "bun run dev" },
      // A Workers custom domain: Cloudflare creates its DNS record and certificate.
      domain: `probabench.${yield* DomainName}`,
      // The custom domain is the only address: no workers.dev or preview URLs.
      workersDev: false,
      assets: {
        notFoundHandling: "single-page-application",
        // In `_headers` syntax. The asset layer makes browsers revalidate every
        // file by default, as index.html and results.json need; Vite's
        // content-hashed bundles never change, so browsers may keep them.
        headers: "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
      },
    });

    return { url: site.url };
  }),
);
