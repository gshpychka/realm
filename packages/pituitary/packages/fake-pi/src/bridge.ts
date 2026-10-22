import { connect } from "node:net";
import {
  BRIDGE_SOCKET_ENV,
  BRIDGE_TOKEN_ENV,
  type BridgeMessage,
  encodeRecord,
  type HostMessage,
  recordReader,
} from "@pituitary/rpc";

/**
 * The scripted agent's end of pituitary's bridge, sending what pi's bridge extension would.
 * Records sent before pituitary accepts the connection wait for it; without a bridge to reach,
 * they go nowhere.
 */
export function bridgeClient(): (message: BridgeMessage) => void {
  const path = process.env[BRIDGE_SOCKET_ENV];
  const token = process.env[BRIDGE_TOKEN_ENV];
  if (!path || !token) return () => {};
  const held: BridgeMessage[] = [];
  let open = false;
  const socket = connect(path);
  // The agent lives as long as pituitary talks to it over stdin, never longer for the bridge.
  socket.unref();
  socket.on("connect", () => socket.write(encodeRecord({ type: "hello", token })));
  socket.on(
    "data",
    recordReader<HostMessage>((message) => {
      if (message.type !== "welcome") return;
      open = true;
      for (const record of held.splice(0)) socket.write(encodeRecord(record));
    }),
  );
  socket.on("error", () => {});
  return (message) => {
    if (open) socket.write(encodeRecord(message));
    else held.push(message);
  };
}
