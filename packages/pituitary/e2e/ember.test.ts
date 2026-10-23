import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { boot, REPO } from "./helpers/harness.ts";

const SHOWCASE = join(REPO, "packages/ember/showcase/main.tsx");

after(async () => {
  await closeAll();
});

/** Boots one showcase view, each fire held on its first warmed frame. */
async function still(view: string): Promise<string> {
  const app = await boot({
    entry: SHOWCASE,
    ready: `ember · ${view}`,
    env: { EMBER_VIEW: view, EMBER_STILL: "1" },
  });
  const screen = await app.capture(`ember-${view}`);
  await app.close();
  return screen;
}

test("every tile size burns under every mapping", async () => {
  const screen = await still("tiles");
  for (const size of ["2x2", "2x3", "3x2", "3x3"]) assert.ok(screen.includes(size), screen);
  assert.match(screen, /[▀▄█▌▐▁▂▃▄▅▆▇░▒▓]/, `no fire drawn:\n${screen}`);
});

test("a one-row band burns along the width", async () => {
  const screen = await still("row1");
  assert.match(screen, /[▁▂▃▄▅▆▇█]{20,}/, `no band drawn:\n${screen}`);
});

test("a two-row band burns along the width", async () => {
  const screen = await still("row2");
  assert.match(screen, /[▀▄█]{20,}/, `no band drawn:\n${screen}`);
});

test("columns burn down the height beside the transcript", async () => {
  const screen = await still("columns");
  assert.match(screen, /cap the retention/, screen);
  assert.match(screen, /[▀▄█▏▎▍▌▋▊▉]/, `no column drawn:\n${screen}`);
});

test("a fire keeps moving", async () => {
  const app = await boot({
    entry: SHOWCASE,
    ready: "ember · tiles",
    env: { EMBER_VIEW: "tiles" },
    settle: false,
  });
  const frames = await app.film("ember-tiles-motion", 3, 250);
  await app.close();
  assert.equal(new Set(frames).size, frames.length, "consecutive frames are identical");
});

test("a live fire resizes without leaving malformed cells behind", async () => {
  const app = await boot({
    entry: SHOWCASE,
    ready: "ember · row2",
    cols: 70,
    rows: 24,
    env: { EMBER_VIEW: "row2" },
    settle: false,
  });
  try {
    await app.capture("ember-resize-wide");
    await app.terminal.resize(36, 24);
    const frames = await app.film("ember-resize-narrow", 3, 120);
    for (const screen of frames) {
      assert.match(screen, /[▀▄█]{12,}/);
      assert.doesNotMatch(screen, /�/);
    }
  } finally {
    await app.close();
  }
});
