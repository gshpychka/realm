import type { ImageContent } from "@pituitary/session";

/** The first character a draft holds an image as, in Supplementary Private Use Area-B. */
const FIRST = 0x100000;

/** The characters that stand for images in a draft. */
const IMAGE_CHARACTER = /[\u{100000}-\u{10fffd}]/gu;

/** The text a prompt names its nth image by. */
export function imageToken(n: number): string {
  return `[image ${n}]`;
}

/** Each `[image N]` in a prompt's text, with N captured. */
export const IMAGE_TOKEN = /\[image (\d+)\]/g;

/**
 * Images pasted into drafts. A draft holds each one as a single character, U+100000 onward by
 * the image's place here, so the image goes wherever the draft's text goes.
 */
export class Attachments {
  private readonly images: ImageContent[] = [];

  /** Keeps `image` and returns the character that stands for it in a draft. */
  add(image: ImageContent): string {
    this.images.push(image);
    return String.fromCodePoint(FIRST + this.images.length - 1);
  }

  /**
   * The draft as a prompt. Each image's character becomes `[image N]`, numbered by where the image
   * first appears, and the images follow in that order.
   */
  resolve(draft: string): { text: string; images: ImageContent[] } {
    const numbers = new Map<ImageContent, number>();
    const images: ImageContent[] = [];
    const text = draft.replace(IMAGE_CHARACTER, (character) => {
      const image = this.images[(character.codePointAt(0) ?? FIRST) - FIRST];
      if (!image) return "";
      let n = numbers.get(image);
      if (n === undefined) {
        images.push(image);
        n = images.length;
        numbers.set(image, n);
      }
      return imageToken(n);
    });
    return { text, images };
  }
}
