import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { PiRpcClient } from "@pituitary/rpc";
import { App } from "./app.tsx";
import { OptInText } from "./components/text.ts";

const client = new PiRpcClient({
  command: process.execPath,
  args: [join(import.meta.dirname, "../../fake-pi/src/main.ts")],
});
client.start();
await client.call({ type: "set_session_name", name: "remote-build" });
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 120, maxFps: 120 });
extend({ text: OptInText });
const root = createRoot(renderer);
const quit = () => {
  root.unmount();
  renderer.destroy();
  void client.close().then(() => process.exit(0));
};
process.on("SIGTERM", quit);
root.render(<App link={client} workspace={{ cwd: "/work", local: false, label: "builder" }} onQuit={quit} />);
