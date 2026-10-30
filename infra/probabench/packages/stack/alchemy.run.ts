import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { STACK_NAME } from "./history-token";

/** The apex domain from modules/common/values.nix, exported by the infra shell. */
const DomainName = Config.NonEmptyString("DOMAIN_NAME");

export default Alchemy.Stack(
  STACK_NAME,
  {
    providers: Cloudflare.providers(),
    // Alchemy uses local state for development and Cloudflare state for deployment.
    state: Layer.unwrap(
      Alchemy.AlchemyContext.useSync(({ dev }) =>
        dev ? Alchemy.localState() : Cloudflare.state(),
      ),
    ),
  },
  Effect.gen(function* () {
    const writeToken = yield* Alchemy.Random("HistoryWriteToken");
    const database = yield* Cloudflare.D1.Database("Results", {
      migrations: "../service/migrations",
    }).pipe(Alchemy.RemovalPolicy.retain());

    const site = yield* Cloudflare.Website.StaticSite("Web", {
      cwd: "../web",
      command: "bun run build",
      outdir: "dist",
      main: "../service/src/worker.ts",
      env: {
        DB: database,
        HISTORY_WRITE_TOKEN: writeToken.text,
      },
      // Vite imports the domain workspace directly; include it in the build hash.
      memo: {
        include: [
          "**/*",
          "../domain/src/**",
          "../domain/package.json",
          "../../tsconfig.base.json",
          "../../package.json",
        ],
        lockfile: true,
      },
      // Alchemy development starts the Vite server.
      dev: { command: "bun run dev" },
      // A Workers custom domain: Cloudflare creates its DNS record and certificate.
      domain: `probabench.${yield* DomainName}`,
      workersDev: false,
      assets: {
        runWorkerFirst: ["/api/*", "/results.json"],
        notFoundHandling: "single-page-application",
        // Vite's content-hashed assets can be cached indefinitely.
        headers: "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
      },
    });

    return { url: site.url, writeToken: writeToken.text };
  }),
);
