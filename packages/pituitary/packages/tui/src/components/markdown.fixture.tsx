/** Hold highlighting at the async boundary while the real PTY draws its initial text. */
import { createCliRenderer, getTreeSitterClient } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState } from "react";
import { Footer } from "./footer.tsx";
import { Markdown } from "./markdown.tsx";

const client = getTreeSitterClient();
const highlight = client.highlightOnce.bind(client);
let release = () => {};
const pending = new Promise<void>((resolve) => {
  release = resolve;
});
client.highlightOnce = async (...args) => {
  await pending;
  return highlight(...args);
};
const content =
  "## Plan\n\nA **bold** paragraph with `code`.\n\n> first paragraph\n>\n> second paragraph\n\n- one item\n- another item";
function Preview() {
  const [released, setReleased] = useState(false);
  useKeyboard((key) => {
    if (key.name === "h") {
      release();
      setReleased(true);
    }
  });
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor="#1d2021">
      <text>highlight {released ? "released" : "pending"}</text>
      <box flexGrow={1} flexDirection="column">
        <Markdown content={content} />
      </box>
      <Footer statuses={{}} turnStatuses={{}} state={null} stats={null} cwd="/資料/é/🇺🇦a🇺🇦" branch={null} />
    </box>
  );
}
createRoot(await createCliRenderer({ exitOnCtrlC: true })).render(<Preview />);
