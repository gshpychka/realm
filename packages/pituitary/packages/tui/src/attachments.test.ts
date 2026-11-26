import { describe, expect, test } from "bun:test";
import type { ImageContent } from "@pituitary/session";
import { Attachments } from "./attachments.ts";

const png = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });

describe("attachments", () => {
  test("a prompt numbers its images by where each first appears", () => {
    const attachments = new Attachments();
    const first = attachments.add(png("first"));
    const second = attachments.add(png("second"));
    const prompt = attachments.resolve(`compare ${second} with ${first}, then ${second} again`);
    expect(prompt.text).toBe("compare [image 1] with [image 2], then [image 1] again");
    expect(prompt.images.map((image) => image.data)).toEqual(["second", "first"]);
  });

  test("a character with no image behind it is dropped", () => {
    const unknown = new Attachments().add(png("elsewhere"));
    expect(new Attachments().resolve(`look ${unknown}`)).toEqual({ text: "look ", images: [] });
  });
});
