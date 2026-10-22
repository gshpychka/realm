import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { launch } from "./helpers/harness.ts";

const GIST = "https://gist.github.com/operator/0123456789abcdef0123456789abcdef";
const VIEWER = "https://pi.dev/session/#0123456789abcdef0123456789abcdef";

after(async () => {
  await closeAll();
});

/** The calls the fake gh logged, leaving out the footer's pull request lookups. */
function shareCalls(home: string): string[] {
  const log = join(home, "gh.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("pr view"));
}

test("/share publishes a secret gist of the HTML export and names both links", async () => {
  const app = await launch({ scenario: "hello", env: { FAKE_GH_UPLOAD: "uploaded.html" } });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/share");
  await app.terminal.waitText(VIEWER);
  const screen = await app.capture("share");
  assert.match(screen, /shared the session/, screen);
  assert.ok(screen.includes(`gist ${GIST}`), screen);
  const [auth, gist, ...rest] = shareCalls(app.home);
  assert.equal(auth, "auth status");
  assert.match(gist ?? "", /^gist create --public=false \S+\/session\.html$/);
  assert.deepEqual(rest, []);
  const exported = (gist ?? "").split(" ").at(-1) ?? "";
  assert.equal(existsSync(dirname(exported)), false, "the export outlived the share");
  assert.match(readFileSync(join(app.cwd, "uploaded.html"), "utf8"), /2 messages/);
  await app.close();
});

test("/share asks the operator to sign in to gh first", async () => {
  const app = await launch({ scenario: "hello", env: { FAKE_GH_AUTH: "out" } });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/share");
  await app.terminal.waitText("run `gh auth login` first");
  await app.capture("share-signed-out");
  assert.deepEqual(shareCalls(app.home), ["auth status"]);
  await app.close();
});

test("/share passes on gh's reason when the gist is refused", async () => {
  const app = await launch({ scenario: "hello", env: { FAKE_GH_GIST: "failing" } });
  await app.terminal.submit("/share");
  await app.terminal.waitText("/share: could not create the gist: HTTP 422: Validation Failed");
  await app.close();
});

test("/share says where to get gh when there is none", async () => {
  const app = await launch({ scenario: "hello", env: { PITUITARY_GH: "/nonexistent/gh" } });
  await app.terminal.submit("/share");
  await app.terminal.waitText("the GitHub CLI (gh) is not installed");
  await app.close();
});

for (const [kind, args, reason] of [
  ["kept in memory", ["--no-session", "--no-extensions"], "Cannot export in-memory session to HTML"],
  ["not saved yet", ["--no-extensions"], "Nothing to export yet - start a conversation first"],
] as const) {
  test(`/share of a session ${kind} stops at pi's export, before gh`, async () => {
    const app = await launch({ pi: [...args] });
    await app.terminal.submit("/share");
    await app.terminal.waitText(`/share: ${reason}`);
    assert.deepEqual(shareCalls(app.home), []);
    await app.close();
  });
}

test("/share with PITUITARY_GH set empty stops before exporting or asking gh", async () => {
  const app = await launch({ scenario: "hello", env: { PITUITARY_GH: "" } });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/share");
  await app.terminal.waitText("/share: the GitHub CLI is turned off; PITUITARY_GH is set empty");
  await app.capture("share-gh-off");
  assert.equal(existsSync(join(app.home, "gh.log")), false);
  await app.close();
});
