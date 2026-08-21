/**
 * How much of an article's description the widget carries.
 *
 * Its own module, and not inside `preview.ts`, because the demo adapter's
 * anonymous `render()` needs it too and `preview.ts` is `server-only`. Two
 * hundred and forty characters is roughly three lines at the card's width.
 */
export const PRESS_EXCERPT_LENGTH = 240;

/**
 * The provider's description, trimmed to a card's worth.
 *
 * The same shortening the SQL resolver applies, and it is applied at the
 * resolver rather than in the renderer for one reason: the anonymous surface
 * should carry what the widget shows and not a paragraph the widget will
 * discard. Two hundred and forty characters is roughly three lines at the
 * card's width.
 *
 * Cut on a word boundary where there is one nearby, because a headline
 * followed by "the restaurant's new menu inclu…" reads as a truncation bug
 * rather than as a summary.
 */
export function excerptOf(content: string | null): string | null {
  const text = content?.replace(/\s+/g, " ").trim() ?? "";
  if (text.length === 0) return null;
  if (text.length <= PRESS_EXCERPT_LENGTH) return text;

  const cut = text.slice(0, PRESS_EXCERPT_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > PRESS_EXCERPT_LENGTH - 40 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[.,;:\s]+$/, "")}…`;
}

