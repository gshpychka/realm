import { theme } from "../theme.ts";

/** A glyph a list row's detail leads with, such as a model's provider mark. */
export interface DetailIcon {
  glyph: string;
  /** The glyph's colour; `null` takes the detail's. */
  colour: string | null;
}

/** A list row's detail, dim, after a space and led by its icon. */
export function Detail({ text, icon }: { text: string; icon?: DetailIcon | undefined }) {
  if (!icon) return <span fg={theme.dim}> {text}</span>;
  return (
    <>
      <span fg={theme.dim}> </span>
      <span fg={icon.colour ?? theme.dim}>{icon.glyph}</span>
      <span fg={theme.dim}> {text}</span>
    </>
  );
}
