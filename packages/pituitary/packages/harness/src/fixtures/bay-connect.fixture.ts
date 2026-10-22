/** Provider-free equivalent of Bay's configured, generation-fenced stdin/stdout bridge. */
import { request } from "node:http";

const [verb, name, ...flags] = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < flags.length; index += 2) {
  const key = flags[index],
    value = flags[index + 1];
  if (!key || value === undefined || !["--id", "--generation"].includes(key)) process.exit(2);
  values.set(key, value);
}
const id = values.get("--id"),
  generation = values.get("--generation");
if (verb !== "connect" || !name || !id || generation === undefined) process.exit(2);
const bridge = request({
  socketPath: process.env.BAY_SOCKET,
  method: "POST",
  path: `/v1/sessions/${encodeURIComponent(name)}/connect`,
  headers: {
    "Content-Type": "application/octet-stream",
    "Bay-Session-ID": id,
    "Bay-Session-Generation": generation,
  },
});
bridge.on("response", (response) => {
  if (
    response.statusCode !== 200 ||
    response.headers["bay-session-id"] !== id ||
    response.headers["bay-session-generation"] !== generation
  ) {
    response.resume();
    console.error("Bay rejected the record or execution generation");
    process.exitCode = 1;
    bridge.destroy();
    process.stdin.pause();
    return;
  }
  response.pipe(process.stdout);
  response.on("end", () => {
    process.stdin.unpipe(bridge);
    process.stdin.pause();
    bridge.end();
  });
});
bridge.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  process.stdin.unpipe(bridge);
  process.stdin.pause();
});
process.stdin.pipe(bridge);
