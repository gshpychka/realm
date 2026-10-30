import { expect, test } from "bun:test";
import type { SessionStats } from "@pituitary/session";
import { fakeSessionState } from "../../../session/src/session.fixture.ts";
import { footerStyle, PALETTE_NAMES } from "../footer-style.ts";
import { glyphs } from "../glyphs.ts";
import { type FooterProps, footerParts, footerRows, type Parts, type Seg } from "./footer.tsx";

const props: FooterProps = {
  state: fakeSessionState,
  stats: { cost: 0.42, contextUsage: { percent: 14 } } as SessionStats,
  cwd: "/work/workspace",
  location: "builder",
  branch: null,
};
const text = (segments: readonly Seg[]) => segments.map((item) => item.text).join("");
test("remote context and native model metadata stay truthful", () => {
  const parts = footerParts(props);
  expect(parts.path).toBe("builder:/work/workspace");
  expect(parts.branch).toBeNull();
  expect(parts.percent).toBe(14);
  expect(parts.cost).toBe("$0.42");
});
test("footer bands fit compact and wide terminals for every palette", () => {
  for (const columns of [12, 24, 40, 80, 100, 148, 200])
    for (const palette of PALETTE_NAMES)
      for (const fast of [false, true]) {
        const rows = footerRows(
          footerParts({ ...props, fast }),
          columns,
          footerStyle({ PITUITARY_FOOTER_PALETTE: palette }),
          false,
        );
        expect(rows.length).toBeLessThanOrEqual(2);
        for (const row of rows)
          expect(Bun.stringWidth(text(row.left) + text(row.right)) + row.hearth).toBeLessThanOrEqual(columns);
      }
});
test("Fast mode marks the model beside its name, and wherever the provider's mark still fits", () => {
  const style = footerStyle({}),
    fast = footerParts({ ...props, fast: true }),
    right = (parts: Parts, columns: number) =>
      text(footerRows(parts, columns, style, false).flatMap((row) => row.right));
  expect(right(fast, 200)).toContain(`${fast.model?.name} ${glyphs.fast}`);
  expect(right(footerParts(props), 200)).not.toContain(glyphs.fast);
  for (let columns = 12; columns <= 200; columns++)
    if (right(fast, columns).includes(fast.model?.mark.glyph ?? ""))
      expect(right(fast, columns)).toContain(glyphs.fast);
});

test("the native cost card opens without inventing subscription limits", () => {
  const parts = footerParts(props),
    style = footerStyle({});
  expect(JSON.stringify(footerRows(parts, 200, style, false))).not.toContain("$0.42");
  expect(JSON.stringify(footerRows(parts, 200, style, true))).toContain("$0.42");
});

test("assembled footer rows with flags fit without additive width assumptions", () => {
  const parts = footerParts({ ...props, state: null, stats: null, cwd: "/🇺🇦a🇺🇦", branch: "🇺🇦" });
  for (const palette of PALETTE_NAMES)
    for (let columns = 1; columns <= 40; columns++)
      for (const row of footerRows(parts, columns, footerStyle({ PITUITARY_FOOTER_PALETTE: palette }), false))
        expect(Bun.stringWidth(text(row.left) + text(row.right)) + row.hearth).toBeLessThanOrEqual(columns);
});
