/**
 * Render model shared with pr-stats: a card is a title with preformatted
 * lines, and each line is a row of colored spans.
 */
export interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  icon?: string;
}

export type Line = Span[];

export interface Card {
  title: string;
  subtitle: Line;
  lines: Line[];
  /**
   * Holds the printed width of the widest row, which the panel uses to
   * decide whether two cards fit side by side.
   */
  width: number;
  /**
   * Makes the card span the full panel width instead of taking one cell of
   * the two-column grid.
   */
  full: boolean;
  /**
   * Optional glyph printed before the title, like a provider's color dot.
   */
  mark: Span | null;
  /**
   * Provider whose logo replaces the mark when the terminal can draw it.
   */
  icon: string | null;
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, span) => sum + span.text.length + (span.icon === undefined ? 0 : 1), 0);
}

export function card(
  title: string,
  subtitle: Line,
  lines: Line[],
  full = false,
  mark: Span | null = null,
  icon: string | null = null,
): Card {
  const markWidth = mark === null ? 0 : mark.text.length + 1;
  const width = Math.max(markWidth + title.length + 2 + lineWidth(subtitle), ...lines.map(lineWidth));

  return { title, subtitle, lines, width, full, mark, icon };
}
