import { describe, expect, test } from "bun:test";
import type { PasteMetadata } from "@opentui/core";
import { PasteEvents, type Terminal } from "./paste-events.ts";

const base64 = (data: string | Buffer) => Buffer.from(data).toString("base64");
const osc = (body: string) => `\x1b]5522;${body}\x1b\\`;

/** A terminal that has paste events, with what is written to it and the pastes handed on. */
function terminal(takesImages: boolean) {
  const written: string[] = [];
  const pasted: { bytes: Buffer; metadata?: PasteMetadata }[] = [];
  const handlers: ((sequence: string) => boolean)[] = [];
  let packet: (sequence: string) => void = () => {};
  const fake: Terminal = {
    writeOut: (chunk) => written.push(chunk) > 0,
    subscribeOsc: (handler) => {
      packet = handler;
      return () => {};
    },
    prependInputHandler: (handler) => {
      handlers.unshift(handler);
    },
    removeInputHandler: () => {},
    keyInput: { processPaste: (bytes, metadata) => pasted.push({ bytes: Buffer.from(bytes), metadata }) },
    on: () => {},
    off: () => {},
  };
  new PasteEvents(fake, () => takesImages);
  for (const handler of handlers) handler("\x1b[?5522;2$y");
  /** The terminal announces a paste of `types`, then answers the read it asks for with `data`. */
  const paste = (types: string, data: Buffer) => {
    packet(osc(`type=read:status=OK:pw=${base64("once")}`));
    packet(osc(`type=read:status=DATA:mime=${base64(".")};${base64(types)}`));
    packet(osc("type=read:status=DONE"));
    const read = written.at(-1) ?? "";
    const id = /:id=([^;]+);/.exec(read)?.[1];
    // The read's payload is the type it asks for, in base64 as a reply names it.
    const mime = read.slice(read.lastIndexOf(";") + 1, -"\x1b\\".length);
    packet(osc(`type=read:status=OK:id=${id}`));
    packet(osc(`type=read:status=DATA:mime=${mime}:id=${id};${base64(data.subarray(0, 3))}`));
    packet(osc(`type=read:status=DATA:mime=${mime}:id=${id};${base64(data.subarray(3))}`));
    packet(osc(`type=read:status=DONE:id=${id}`));
    return read;
  };
  return { written, pasted, paste };
}

describe("paste events", () => {
  test("a terminal that has them gets them turned on", () => {
    const { written } = terminal(true);
    expect(written).toEqual(["\x1b[?5522$p", "\x1b[?5522h"]);
  });

  test("while the draft takes images, a paste reads the image with the event's password", () => {
    const { pasted, paste } = terminal(true);
    const image = Buffer.from("not really a png");
    const read = paste("text/plain image/png", image);
    expect(read).toBe(
      osc(
        `type=read:pw=${base64("once")}:name=${base64("Paste event")}:id=pituitary-1;${base64("image/png")}`,
      ),
    );
    expect(pasted).toEqual([{ bytes: image, metadata: { mimeType: "image/png", kind: "binary" } }]);
  });

  test("elsewhere a paste reads the text", () => {
    const { pasted, paste } = terminal(false);
    paste("image/png text/plain", Buffer.from("hello there"));
    expect(pasted).toEqual([
      { bytes: Buffer.from("hello there"), metadata: { mimeType: "text/plain", kind: "text" } },
    ]);
  });
});
