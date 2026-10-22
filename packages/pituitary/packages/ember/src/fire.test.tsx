import { expect, mock, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { act, useState } from "react";
import { Fire } from "./fire.tsx";

test("a fire carries its heat through a resize without kindling again", async () => {
  const fuel = mock(() => 1);
  const app = await createTestRenderer({ width: 8, height: 2 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Fire width="100%" height="100%" fuel={fuel} still />));
    await app.renderOnce();
    expect(app.captureCharFrame().trim().length).toBeGreaterThan(0);
    const samples = fuel.mock.calls.length;
    expect(samples).toBeGreaterThan(0);
    app.resize(14, 3);
    await app.renderOnce();
    expect(app.captureCharFrame().trim().length).toBeGreaterThan(0);
    expect(fuel.mock.calls.length).toBe(samples);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("removing a tuning prop restores its default while the fire keeps burning", async () => {
  const fuel = mock(() => 1);
  const app = await createTestRenderer({ width: 8, height: 2 });
  const root = createRoot(app.renderer);
  let removeFuel: () => void = () => {};
  function Probe() {
    const [custom, setCustom] = useState(true);
    removeFuel = () => setCustom(false);
    return <Fire width="100%" height="100%" fuel={custom ? fuel : undefined} pace={5} />;
  }
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => {
      root.render(<Probe />);
    });
    await app.renderOnce();
    await act(async () => {
      removeFuel();
    });
    await app.renderOnce();
    const samples = fuel.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fuel.mock.calls.length).toBe(samples);
  } finally {
    await act(async () => root.unmount());
    app.renderer.destroy();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  }
});
