import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "ProbaBench",
  {
    providers: AWS.providers(),
    // Alchemy's AWS state store resolves real credentials even in dev mode.
    // Keep local development independent of the account's remote state.
    state: Layer.unwrap(
      Alchemy.AlchemyContext.useSync(({ dev }) => (dev ? Alchemy.localState() : AWS.state())),
    ),
  },
  Effect.gen(function* () {
    const site = yield* AWS.Website.StaticSite("Web", {
      path: "../web",
      build: {
        command: "bun run build",
        output: "dist",
        // Vite imports the domain workspace directly. Include it in the build
        // hash so schema-only changes cannot reuse an outdated frontend build.
        // The history sits outside packages/web too, so it is named here, or a
        // data-only change would reuse an outdated build. An explicit include
        // leaves bun.lock out of the hash unless lockfile is set.
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
      dev: { command: "bun run dev" },
      spa: true,
      // This bucket holds reproducible build artifacts, so destroy can remove it.
      forceDestroy: true,
      assets: {
        fileOptions: [
          {
            // The history keeps its name across benchmark runs. Alchemy's default
            // for non-HTML files is a year-long immutable browser cache. The name is
            // @probabench/domain's RESULTS_FILE, which this Effect 4 stack cannot
            // import from the Effect 3 domain.
            files: "results.json",
            cacheControl: "public,max-age=0,must-revalidate",
          },
        ],
      },
      // Invalidate the app shell and the mutable results together, and return
      // only once CloudFront can serve the completed release.
      invalidation: { paths: "all", wait: true },
    });

    return { url: site.url };
  }),
);
