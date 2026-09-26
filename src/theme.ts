/**
 * Palette of pr-stats (github.com/d3lm/pr-stats, MIT), value for value, so
 * both tools look the same side by side: a warm amber accent family over
 * the #1e1e1e background, which the app paints itself (see App.tsx) rather
 * than inheriting the terminal's. faint is dim under another name, kept
 * for decoration that carries no information.
 */
export const theme = {
  bg: '#1e1e1e',
  border: '#363636',
  text: '#ffffff',
  muted: '#959595',
  dim: '#5d5d5d',
  faint: '#5d5d5d',
  accent: '#f0b689',
  selectedBg: '#483e35',
  inputBg: '#2a2a2a',
  // the subtle track behind every chart area, pr-stats' input gray
  chartBg: '#2a2a2a',
  warn: '#f0b689',
  error: '#ff8080',
  success: '#89f0ab',
  chartBar: '#b98d63',
  chartLine: '#c99a6f',
  chartDim: '#6e563f',
  heat: ['#5c4732', '#8a6a49', '#c0925f', '#f0b689'],
};

/**
 * Brand hue of each provider, for the dot before its name so providers
 * tell apart at a glance. Cursor and Devin brand in black, which would
 * vanish on the dark background, so they get readable stand-ins. Every
 * value clears 3:1 against the background, the WCAG minimum for
 * non-text marks.
 */
export const brand: Record<string, string> = {
  claude: '#de7356',
  codex: '#74aa9c',
  cursor: '#d4d4d4',
  'antigravity-cli': '#4285f4',
  devin: '#b392f0',
};

/**
 * Picks the bar color for how full a quota is, calm below 60%, the accent
 * from there, and red once it passes 85%.
 */
export function levelColor(fraction: number): string {
  if (fraction >= 0.85) {
    return theme.error;
  }

  if (fraction >= 0.6) {
    return theme.accent;
  }

  return theme.chartBar;
}
