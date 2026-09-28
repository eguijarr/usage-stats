import * as asciichart from 'asciichart';
import {
  elapsedFraction,
  expiringShare,
  fastBurnOf,
  type FastBurn,
  FOCUS_MIN_EXPIRING,
  type Forecast,
  forecastOf,
  formatDuration,
  formatPercent,
  formatUsed,
  fraction,
  padEnd,
  padStart,
  resetGroupOf,
  type ResetGroup,
} from './format';
import type { Sample } from './history';
import { card, lineWidth, type Card, type Line, type Span } from './model';
import { recentPace, type ActivityProfile } from './pace';
import { planVerdict, quotaFit, type PlanVerdict } from './plan';
import type { ProgressLine, ProviderSnapshot } from './providers/types';
import { brand, levelColor, theme } from './theme';

export interface ProviderState {
  id: string;
  snapshot: ProviderSnapshot | null;
  error: string | null;
  probing: boolean;
  lastOk: number | null;
  durationMs: number | null;
  /**
   * Start of the running probe, which lets a slow provider show how long
   * it has been waiting instead of a bare spinner.
   */
  probeStartedAt: number | null;
}

/**
 * Knobs the views need from the app. Data older than staleAfterMs is
 * flagged, since a quota view that silently stops updating misleads.
 */
export interface ViewOptions {
  now: number;
  staleAfterMs: number;
  terminalWidth?: number;
  /**
   * The user's usual hours, which forecasts follow once the history has
   * taught them; null or missing keeps the same pace around the clock.
   */
  profile?: ActivityProfile | null;
}

export interface View {
  /**
   * Summary items spread over the pinned strip under the tab bar.
   */
  strip: Line[];
  heading: string | null;
  headingIcon?: string | null;
  headline: Line | null;
  cards: Card[];
  empty: string | null;
}

/**
 * Trend windows the w key cycles through.
 */
export const WINDOWS = [
  { label: '6h', ms: 6 * 3600_000 },
  { label: '24h', ms: 24 * 3600_000 },
  { label: '7d', ms: 7 * 24 * 3600_000 },
];

const KNOWN_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  'antigravity-cli': 'Antigravity CLI',
  devin: 'Devin',
};

export function displayName(state: ProviderState): string {
  return state.snapshot?.displayName ?? KNOWN_NAMES[state.id] ?? state.id;
}

export function brandColor(id: string): string {
  return brand[id] ?? theme.muted;
}

function brandMark(id: string): Span {
  return { text: '●', fg: brandColor(id) };
}

// pr-stats' widths: 24 cells in its bars cards, 36 in its histograms
const BAR_WIDTH = 24;
const WIDE_BAR_WIDTH = 36;
const SPARK_CELLS = 10;
const SPARK_WINDOW_MS = 24 * 3600_000;
const MAX_LABEL = 32;
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * A reading at most this old when a window starts still holds at its
 * start: longer than the history's 5-minute heartbeat for repeated values
 * and the slowest 10-minute poll, shorter than a real gap in the history.
 */
const CARRY_MS = 15 * 60_000;

/**
 * One quota's samples inside a window. The history skips repeated values,
 * so the last reading before the window, when recent, is moved to its
 * start to keep the value the window opened with.
 */
function windowSamples(history: Sample[], providerId: string, label: string, start: number): Sample[] {
  let before: Sample | null = null;
  const inside: Sample[] = [];

  for (const sample of history) {
    if (sample.p !== providerId || sample.l !== label) continue;
    if (sample.t >= start) inside.push(sample);
    else if (before === null || sample.t >= before.t) before = sample;
  }

  return before !== null && start - before.t <= CARRY_MS ? [{ ...before, t: start }, ...inside] : inside;
}

function progressLines(state: ProviderState): ProgressLine[] {
  return (state.snapshot?.lines ?? []).filter((line): line is ProgressLine => line.type === 'progress');
}

function forecastFor(line: ProgressLine, state: ProviderState, options: ViewOptions): Forecast | null {
  return forecastOf(line, options.now, state.lastOk ?? options.now, options.profile ?? null);
}

function fastBurnFor(line: ProgressLine, state: ProviderState, history: Sample[], options: ViewOptions): FastBurn | null {
  return fastBurnOf(line, recentPace(history, state.id, line.label, options.now), options.now,
    state.lastOk ?? options.now, forecastFor(line, state, options), options.profile ?? null);
}

function paceText(perHour: number): string {
  const points = perHour * 100;
  return `+${points < 10 ? points.toFixed(1) : Math.round(points)} pts/h`;
}

/** A burst, in the words of the forecasts next to it. */
function fastSpan(fast: FastBurn): Span {
  return { text: `↑ fast ${paceText(fast.perHour)}, out in ~${formatDuration(fast.inMs)} at this pace`, fg: theme.error };
}

export type BarStyle = 'scattered' | 'subtle' | 'contrast' | 'solid';

function darkenBar(hex: string, factor = 0.45): string {
  if (!hex.startsWith('#') || hex.length < 7) {
    return theme.chartDim;
  }
  const num = Number.parseInt(hex.slice(1, 7), 16);
  const r = Math.round(((num >> 16) & 0xff) * factor);
  const g = Math.round(((num >> 8) & 0xff) * factor);
  const b = Math.round((num & 0xff) * factor);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/**
 * Continuous bars with 1-pixel retro dither:
 * - 'subtle': tramado sutil uniforme de micropíxeles de 1px en toda la zona coloreada (por defecto)
 * - 'contrast': tramado de micropíxeles con mayor contraste
 * - 'scattered': celdas con micropíxeles dispersos aleatoriamente
 * - 'solid': barra lisa sin tramado
 */
function bar(
  value: number,
  width: number,
  color: string,
  style: BarStyle = 'subtle',
  seed = 0,
): Span[] {
  const used = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const cells = used * width;
  let whole = Math.floor(cells);
  let partial = Math.round((cells - whole) * 8);

  if (partial === 8) {
    whole += 1;
    partial = 0;
  }

  // a nonzero quota always shows at least a sliver
  if (whole === 0 && partial === 0 && used > 0) {
    partial = 1;
  }

  const spans: Span[] = [];

  if (whole > 0) {
    if (style === 'solid') {
      spans.push({ text: ' '.repeat(whole), bg: color });
    } else if (style === 'subtle') {
      const darkFg = darkenBar(color, 0.65);
      spans.push({ text: '░'.repeat(whole), fg: darkFg, bg: color });
    } else if (style === 'contrast') {
      const darkFg = darkenBar(color, 0.40);
      spans.push({ text: '░'.repeat(whole), fg: darkFg, bg: color });
    } else {
      // 'scattered': ~28% random cells have 1-pixel stipple
      const darkFg = darkenBar(color, 0.45);
      const cellSpans: Span[] = [];

      for (let i = 0; i < whole; i++) {
        const h = Math.abs(Math.sin((seed + 1) * 37.17 + (i + 1) * 19.31)) * 10000;
        const frac = h - Math.floor(h);

        if (frac < 0.28) {
          cellSpans.push({ text: '░', fg: darkFg, bg: color });
        } else {
          cellSpans.push({ text: ' ', bg: color });
        }
      }

      spans.push(...merge(cellSpans));
    }
  }

  if (partial > 0) {
    spans.push({ text: EIGHTHS[partial]!, fg: color, bg: theme.chartBg });
  }

  // the unused part shows the bar's full extent on the chart track
  const remaining = width - whole - (partial > 0 ? 1 : 0);
  if (remaining > 0) {
    spans.push({ text: ' '.repeat(remaining), bg: theme.chartBg });
  }

  return spans;
}

/**
 * Joins neighboring spans of the same style, so a bar renders as a few
 * spans instead of one per cell.
 */
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];

  for (const span of spans) {
    const last = out.at(-1);

    if (last && last.fg === span.fg && last.bg === span.bg && last.bold === span.bold) {
      last.text += span.text;
    } else {
      out.push({ ...span });
    }
  }

  return out;
}

/**
 * Condenses the last 24 hours of a quota into a few block characters, each
 * cell holding the highest reading of its slice. Cells before the first
 * sample stay blank, so a young history reads as young.
 */
function sparkline(history: Sample[], providerId: string, label: string, now: number): Span[] {
  const start = now - SPARK_WINDOW_MS;
  const samples = windowSamples(history, providerId, label, start);

  if (samples.length < 2) {
    return [{ text: '·'.repeat(SPARK_CELLS), fg: theme.faint, bg: theme.chartBg }];
  }

  const cells: (number | null)[] = Array.from({ length: SPARK_CELLS }, () => null);

  for (const sample of samples) {
    const index = Math.min(SPARK_CELLS - 1, Math.floor(((sample.t - start) / SPARK_WINDOW_MS) * SPARK_CELLS));
    cells[index] = Math.max(cells[index] ?? 0, sample.v);
  }

  let previous: number | null = null;
  const filled = cells.map((cell) => (previous = cell ?? previous));
  const top = Math.max(0.2, ...filled.map((cell) => cell ?? 0));

  return merge(
    filled.map((cell) =>
      cell === null
        ? { text: '·', fg: theme.faint, bg: theme.chartBg }
        : { text: SPARK_CHARS[Math.min(7, Math.round((cell / top) * 7))]!, fg: theme.chartLine, bg: theme.chartBg },
    ),
  );
}

/**
 * When a quota next resets, or null when the provider sent no date, one
 * that does not parse, or one already past. Only such a date drives
 * countdowns, forecasts and priorities.
 */
export function nextResetAt(line: ProgressLine, now: number): number | null {
  if (line.resetsAt === null) return null;
  const reset = Date.parse(line.resetsAt);
  return Number.isFinite(reset) && reset > now ? reset : null;
}

/** The countdown to a quota's next reset, or "unknown" without one. */
export function resetEta(line: ProgressLine, now: number): string {
  const reset = nextResetAt(line, now);
  return reset === null ? 'unknown' : formatDuration(reset - now);
}

function resetIn(line: ProgressLine, now: number): string {
  if (line.resetsAt === null) {
    return '';
  }

  const remaining = Date.parse(line.resetsAt) - now;

  return remaining <= 0 ? '⟳ now' : `⟳ ${formatDuration(remaining)}`;
}

function resetAt(line: ProgressLine, calendarDate = false): string {
  return line.resetsAt === null
    ? ''
    : new Date(line.resetsAt).toLocaleString([], {
        ...(calendarDate ? { day: 'numeric' as const, month: 'short' as const } : { weekday: 'short' as const }),
        hour: '2-digit', minute: '2-digit',
      });
}

/**
 * Picks a bar's color the way pr-stats does: its chart brown for every
 * row and the accent for the one row worth the eye, here the provider's
 * tightest quota. Unlike pr-stats, a quota at 85% or more turns red, since
 * running out is the one thing this tool must not let slip by.
 */
function barColor(used: number, highlight: boolean): string {
  if (used >= 0.85) {
    return theme.error;
  }

  return highlight ? theme.accent : theme.chartBar;
}

/**
 * Tells in words where the quota is heading, as an annotation after the
 * row like pr-stats' "← p50 2.4h": when it runs out if the current rate
 * would exhaust it before the reset, or roughly where it lands at the
 * reset otherwise. Dollar and count quotas without a period show their
 * amounts instead.
 */
function forecastSpan(line: ProgressLine, forecast: Forecast | null): Span {
  if (forecast?.kind === 'exhausted') {
    return { text: '← exhausted', fg: theme.error };
  }

  if (forecast?.kind === 'runsOut') {
    return { text: forecast.inMs > 0 ? `← runs out in ~${formatDuration(forecast.inMs)}` : '← may be exhausted · r refresh', fg: theme.error };
  }

  if (forecast?.kind === 'atReset') {
    const at = `~${formatPercent(forecast.fraction)} used at reset`;
    return forecast.fraction >= 0.8 ? { text: `← ${at}`, fg: theme.accent } : { text: at, fg: theme.dim };
  }

  return line.format.kind === 'percent' ? { text: '' } : { text: formatUsed(line), fg: theme.dim };
}

/**
 * Keep the comparison rows short: label, uninterrupted fill, aligned
 * value, and reset. Longer annotations sit beneath the common scale.
 */
function quotaRow(
  line: ProgressLine,
  labelWidth: number,
  barWidth: number,
  now: number,
  showReset: boolean,
  highlight: boolean,
  style: BarStyle = 'subtle',
  seed = 0,
): Line {
  const used = fraction(line);
  const row: Line = [
    { text: `${shortLabel(line.label, labelWidth)} `, fg: theme.muted },
    ...bar(used, barWidth, barColor(used, highlight), style, seed),
    { text: padStart(formatPercent(used), 6), fg: used === 0 ? theme.dim : theme.text },
  ];

  if (showReset && line.resetsAt !== null) {
    row.push({ text: `  ${resetIn(line, now)}`, fg: theme.muted });
  }

  return row;
}

function shortLabel(label: string, width: number): string {
  return label.length > width ? `${label.slice(0, width - 1)}…` : padEnd(label, width);
}

/** Wrap annotations at words, preserving colors and keeping chart rows intact. */
function annotationRows(parts: Line, width: number): Line[] {
  const rows: Line[] = [];
  let row: Line = [];
  let used = 0;
  const finishRow = () => {
    while (row.length > 0) {
      const last = row.at(-1)!;
      last.text = last.text.trimEnd();
      if (last.text.length > 0) break;
      row.pop();
    }
    if (row.length > 0) rows.push(merge(row));
    row = [];
    used = 0;
  };

  for (const part of parts) {
    for (const word of part.text.match(/\S+\s*|\s+/g) ?? []) {
      if (used > 0 && used + word.trimEnd().length > width) {
        finishRow();
      }
      let value = used === 0 ? word.trimStart() : word;
      // A provider can report an unbroken model id wider than a phone.
      while (value.trimEnd().length > width) {
        row.push({ ...part, text: value.slice(0, width) });
        finishRow();
        value = value.slice(width);
      }
      if (value.length === 0) continue;
      row.push({ ...part, text: value });
      used += value.length;
    }
  }

  finishRow();
  return rows;
}

/**
 * The scale under the bars, drawn like the axis of pr-stats' histograms:
 * a tick row and a number row in dim gray, at every quarter.
 */
function axisRows(labelWidth: number, width: number): Line[] {
  const offset = labelWidth + 1;
  const ticks = Array.from({ length: offset + width }, () => ' ');
  const numbers = Array.from({ length: offset + width + 4 }, () => ' ');

  const values = width < 12 ? [0, 100] : width < 24 ? [0, 50, 100] : [0, 25, 50, 75, 100];
  for (const value of values) {
    const at = offset + Math.round((value / 100) * (width - 1));
    const label = value === 100 ? '100%' : String(value);

    ticks[at] = '╵';
    // Center inner labels and keep both ends inside the plot.
    const start = value === 100 ? at - label.length + 1 : value === 0 ? at : at - Math.floor(label.length / 2);

    for (let i = 0; i < label.length; i++) {
      numbers[start + i] = label[i]!;
    }
  }

  return [[{ text: ticks.join('').trimEnd(), fg: theme.dim }], [{ text: numbers.join('').trimEnd(), fg: theme.dim }]];
}

function statusSubtitle(state: ProviderState, options: ViewOptions): Line {
  const { now, staleAfterMs } = options;
  const parts: Line = [];
  const waited = state.probing && state.probeStartedAt !== null ? now - state.probeStartedAt : 0;
  const stale = state.lastOk !== null && now - state.lastOk > staleAfterMs;

  if (state.snapshot?.plan) {
    parts.push({ text: state.snapshot.plan, fg: theme.muted }, { text: ' · ', fg: theme.dim });
  }

  if (state.snapshot === null) {
    if (state.error !== null) {
      parts.push({ text: '✕ error', fg: theme.error });
    } else {
      parts.push({ text: state.probing ? `◌ probing${waited > 2000 ? ` ${formatDuration(waited)}` : '…'}` : '○ waiting', fg: theme.muted });
    }

    return parts;
  }

  if (state.error !== null || stale) {
    parts.push({ text: '! stale', fg: theme.warn });
  } else {
    parts.push({ text: 'ok', fg: theme.muted });
  }

  if (state.lastOk !== null) {
    parts.push({ text: ` · updated ${formatDuration(now - state.lastOk)} ago`, fg: stale ? theme.warn : theme.dim });
  }

  // a probe that answers within 2s refreshes silently, only slow ones show their wait
  if (waited > 2000) {
    parts.push({ text: ` · ↻ ${formatDuration(waited)}`, fg: theme.accent });
  }

  return parts;
}

const RETRY_HINT: Span = { text: '  (r retries)', fg: theme.dim };

function quotaRows(
  state: ProviderState,
  history: Sample[],
  options: ViewOptions,
  availableWidth: number,
  sharedLabelWidth: number,
  wide = false,
): Line[] {
  const { now } = options;
  const lines = progressLines(state);
  const labelWidth = Math.min(sharedLabelWidth, Math.max(8, Math.floor(availableWidth / 3)));
  const showReset = availableWidth >= labelWidth + 1 + 16 + 6 + 13;
  const barWidth = Math.max(8, Math.min(
    wide ? WIDE_BAR_WIDTH : BAR_WIDTH,
    availableWidth - labelWidth - 7 - (showReset ? 13 : 0),
  ));
  const tightest = lines.reduce((best, line, i) => (fraction(line) > fraction(lines[best] ?? line) ? i : best), 0);
  const compact = availableWidth < 40;
  const compactBarWidth = Math.max(4, availableWidth - 7);
  const rows = lines.flatMap((line, i) => {
    return compact ? [
      ...annotationRows([{ text: line.label, fg: theme.muted }], availableWidth),
      [...bar(fraction(line), compactBarWidth, barColor(fraction(line), i === tightest), 'subtle'),
        { text: padStart(formatPercent(fraction(line)), 6), fg: theme.text }],
    ] : [quotaRow(line, labelWidth, barWidth, now, showReset, i === tightest && fraction(line) > 0, 'subtle')];
  });

  if (lines.length > 0) {
    rows.push(...axisRows(compact ? -1 : labelWidth, compact ? compactBarWidth : barWidth));
  }

  const annotations: Line[] = [];
  const resetLabels = lines.map((line) =>
    line.resetsAt === null ? '' : `${resetIn(line, now)} (${resetAt(line)})`,
  );
  const resetWidth = Math.max(0, ...resetLabels.map((label) => label.length));
  for (const [i, line] of lines.entries()) {
    const outlook = forecastFor(line, state, options);
    const forecast = forecastSpan(line, outlook);
    const atRisk = ['runsOut', 'exhausted'].includes(outlook?.kind ?? '');
    const fast = fastBurnFor(line, state, history, options);
    const pace = wide && fast === null ? recentPace(history, state.id, line.label, now) : null;
    const parts: Line = [];

    if (wide) {
      parts.push(...sparkline(history, state.id, line.label, now), { text: '  ' });
    }
    if ((!showReset || wide) && line.resetsAt !== null) {
      parts.push({ text: `${wide ? resetLabels[i]!.padEnd(resetWidth) : resetIn(line, now)}  `, fg: theme.muted });
    }
    if (wide) {
      const elapsed = elapsedFraction(line, now);
      if (elapsed !== null) parts.push({ text: `${padStart(formatPercent(elapsed), 4)} elapsed  `, fg: theme.dim });
    }
    if (wide || atRisk) parts.push(forecast);
    if (fast !== null) {
      parts.push({ text: parts.length > 0 ? '  ' : '' }, fastSpan(fast));
    } else if (pace !== null && pace.perHour > 0) {
      parts.push({ text: `  ${paceText(pace.perHour)} last 1h`, fg: theme.dim });
    }
    if (line.format.kind !== 'percent' && (!wide || outlook !== null)) {
      parts.push({ text: `  ${formatUsed(line)}`, fg: theme.muted });
    }
    if (parts.length > 0) {
      annotations.push(...annotationRows([
        { text: `${line.label.padEnd(wide ? labelWidth : 0)}  `, fg: theme.muted },
        ...parts,
      ], availableWidth));
    }
  }
  if (annotations.length > 0) {
    rows.push([], ...annotations);
  }

  if (state.error !== null) {
    rows.push(...annotationRows([{ text: `✕ ${state.error}`, fg: theme.error }, RETRY_HINT], availableWidth));
  } else if (state.snapshot !== null && lines.length === 0) {
    rows.push(...annotationRows([{ text: 'this provider reported no quotas', fg: theme.muted }], availableWidth));
  } else if (state.snapshot === null) {
    rows.push(...annotationRows([{ text: 'reading the login and asking the provider…', fg: theme.dim }], availableWidth));
  }

  return rows;
}

/**
 * A decision first, then upcoming resets and every provider's quotas.
 * The full provider cards keep model pools and other balances visible.
 */
export function overviewView(allStates: ProviderState[], history: Sample[], options: ViewOptions): View {
  const { now } = options;
  // quotas marked detail-only stay on their provider's tab, out of every overview card
  const states = allStates.map((state) =>
    state.snapshot === null
      ? state
      : { ...state, snapshot: { ...state.snapshot, lines: state.snapshot.lines.filter((line) => line.type !== 'progress' || !line.detailOnly) } },
  );
  const ok = states.filter((state) => state.snapshot !== null && resetDataNotice(state, options) === null).length;
  const failed = states.filter((state) => state.error !== null).length;

  const all = states.flatMap((state) => progressLines(state).map((line) => ({ state, line })));
  const valid = all.filter(({ line }) => !line.auxiliary && Number.isFinite(line.used) && line.used >= 0 &&
    Number.isFinite(line.limit) && line.limit > 0);
  // recommendations, alerts and priorities only weigh quotas with a real future reset
  const resets: ResetEntry[] = valid
    .filter(({ line }) => nextResetAt(line, now) !== null)
    .sort((a, b) => nextResetAt(a.line, now)! - nextResetAt(b.line, now)!)
    .map(({ state, line }) => ({ state, line, fast: fastBurnFor(line, state, history, options) }));
  // a quota whose provider sent no future reset still gets its row when its cadence is known,
  // like Claude's session between windows, with the countdown shown as unknown
  const undated: ResetEntry[] = valid
    .filter(({ line }) => nextResetAt(line, now) === null && resetGroupOf(line) !== 'other')
    .map(({ state, line }) => ({ state, line, fast: null }));
  const atRisk = resets.filter(({ state, line }) => {
    if (line.auxiliary || resetDataNotice(state, options) !== null) return false;
    const kind = forecastFor(line, state, options)?.kind;
    return kind === 'runsOut' || kind === 'exhausted';
  });
  const burning = resets.filter((entry) => entry.fast !== null && resetDataNotice(entry.state, options) === null);

  const strip: Line[] = [
    [
      { text: String(states.length), fg: theme.text, bold: true },
      { text: ' providers  ', fg: theme.muted },
      { text: String(ok), fg: theme.text, bold: true },
      { text: ' current', fg: theme.muted },
      ...(failed > 0
        ? [
            { text: '  ', fg: theme.muted },
            { text: String(failed), fg: theme.error, bold: true },
            { text: ' failing', fg: theme.muted },
          ]
        : []),
    ],
    atRisk.length > 0
      ? [
          { text: String(atRisk.length), fg: theme.error, bold: true },
          { text: atRisk.length === 1 ? ' quota at risk' : ' quotas at risk', fg: theme.muted },
        ]
      : [],
    burning.length > 0
      ? [
          { text: String(burning.length), fg: theme.error, bold: true },
          { text: ' burning fast', fg: theme.muted },
        ]
      : [],
  ];

  const panelWidth = Math.max(20, (options.terminalWidth ?? 140) - 4);
  const cards: Card[] = [];
  if (resets.length > 0 || undated.length > 0) {
    const focus = focusOf(resets, options);
    if (resets.length > 0) cards.push(recommendationCard(resets, focus, options, panelWidth));
    cards.push(resetsCard([...resets, ...undated], focus, options, panelWidth));
  }

  const columnWidth = states.length > 1 && panelWidth >= 116 ? Math.floor((panelWidth - 4) / 2) : panelWidth;
  const labelWidth = Math.min(MAX_LABEL, Math.max(8, ...all.map(({ line }) => line.label.length)));
  for (const state of states) {
    const rows = quotaRows(state, history, options, columnWidth, labelWidth);
    for (const line of state.snapshot?.lines ?? []) {
      if (line.type === 'text' || line.type === 'badge') {
        rows.push(...annotationRows([
          { text: `${line.label}  `, fg: theme.muted },
          { text: line.type === 'text' ? line.value : line.text, fg: theme.text },
          ...(line.type === 'text' && line.subtitle ? [{ text: ` · ${line.subtitle}`, fg: theme.dim }] : []),
        ], columnWidth));
      }
    }
    if (state.snapshot?.warning) rows.push(...annotationRows([{ text: state.snapshot.warning, fg: theme.warn }], columnWidth));
    // only a verdict worth acting on reaches the overview, the rest stays on the tab
    const verdict = verdictOf(state, history);
    if (verdict?.kind === 'upgrade' || verdict?.kind === 'downsize') {
      rows.push(...annotationRows([{ text: 'plan  ', fg: theme.muted }, verdictSpan(verdict, history, now)], columnWidth));
    }
    cards.push(card(displayName(state), [
      { text: '% used · ', fg: theme.muted }, ...statusSubtitle(state, options),
    ], rows, false, brandMark(state.id), state.id));
  }

  cards.push(hoursCard(options, panelWidth));

  return { strip, heading: null, headline: null, cards, empty: null };
}

const RESET_GROUPS: { key: ResetGroup; title: string }[] = [
  { key: 'session', title: 'Session / daily' },
  { key: 'weekly', title: 'Weekly' },
  { key: 'monthly', title: 'Monthly' },
  { key: 'other', title: 'Other resets' },
];

type ResetEntry = { state: ProviderState; line: ProgressLine; fast: FastBurn | null };

/**
 * Only declared dependencies can constrain a quota. Sibling model pools
 * are independent even when they have the same provider and reset date.
 */
function blockerOf(entry: ResetEntry, options: ViewOptions): { line: ProgressLine; usedUp: boolean; inMs: number } | null {
  const { now } = options;
  const others = progressLines(entry.state).filter((line) =>
    entry.line.dependsOn?.includes(line.label) && line !== entry.line && line.limit > 0 &&
    (line.resetsAt === null || nextResetAt(line, now) !== null),
  );
  // Every exhausted dependency must refill before work can resume.
  const usedUp = others.filter((line) => line.used >= line.limit)
    .sort((a, b) => (nextResetAt(b, now) ?? Infinity) - (nextResetAt(a, now) ?? Infinity))[0];

  if (usedUp !== undefined) {
    return { line: usedUp, usedUp: true, inMs: 0 };
  }

  // without a future reset of its own there is no window for another quota to cap
  const reset = nextResetAt(entry.line, now);
  if (reset === null) return null;
  const capping = others.flatMap((line) => {
    const forecast = forecastFor(line, entry.state, options);
    const lineReset = nextResetAt(line, now);
    // A shorter window can refill several times before this quota resets.
    return forecast?.kind === 'runsOut' && now + forecast.inMs < reset &&
      lineReset !== null && lineReset >= reset
      ? [{ line, usedUp: false, inMs: forecast.inMs }] : [];
  }).sort((a, b) => a.inMs - b.inMs)[0];

  return capping ?? null;
}

/**
 * A shorter window's unused share only goes to waste while the longer
 * budget it draws from has room. When that budget runs out before its own
 * reset at this pace, all of it gets used anyway, whatever this window
 * leaves behind, so steering work here recovers nothing.
 */
function parentRunsOut(entry: ResetEntry, options: ViewOptions): boolean {
  const reset = nextResetAt(entry.line, options.now);
  if (reset === null) return false;

  return progressLines(entry.state).some((line) => {
    const lineReset = nextResetAt(line, options.now);
    return entry.line.dependsOn?.includes(line.label) && line !== entry.line && lineReset !== null &&
      lineReset >= reset && forecastFor(line, entry.state, options)?.kind === 'runsOut';
  });
}

function constraintFirst(blocker: ReturnType<typeof blockerOf>, forecast: ReturnType<typeof forecastOf>): boolean {
  return blocker !== null && (blocker.usedUp || forecast?.kind !== 'runsOut' || blocker.inMs < forecast.inMs);
}

function entryName(entry: ResetEntry): string {
  const name = displayName(entry.state);

  // "Cursor Models" rather than "Cursor Cursor Models"
  return entry.line.label.startsWith(name) ? entry.line.label : `${name} ${entry.line.label}`;
}

function resetDataNotice(state: ProviderState, options: ViewOptions): string | null {
  if (state.error !== null || state.lastOk === null || options.now - state.lastOk > options.staleAfterMs) {
    return 'stale data · r refresh';
  }
  return state.snapshot?.warning ? 'check provider warning' : null;
}

function expiringText(entry: ResetEntry, options: ViewOptions): Span {
  const { now } = options;
  const notice = resetDataNotice(entry.state, options);
  if (notice !== null) return { text: notice, fg: theme.warn };
  const forecast = forecastFor(entry.line, entry.state, options);
  const expiring = expiringShare(entry.line, now, entry.state.lastOk ?? now, options.profile ?? null);
  const blocker = blockerOf(entry, options);

  if (forecast?.kind === 'exhausted') {
    return { text: 'fully used', fg: theme.error };
  }

  if (blocker?.usedUp) {
    return { text: `blocked by ${blocker.line.label}`, fg: theme.warn };
  }

  if (constraintFirst(blocker, forecast)) {
    return { text: blocker!.inMs > 0 ? `may hit ${blocker!.line.label} first` : `may be blocked by ${blocker!.line.label} · r refresh`, fg: theme.muted };
  }

  if (forecast?.kind === 'runsOut') {
    return { text: forecast.inMs > 0 ? `runs out in ~${formatDuration(forecast.inMs)}` : 'may be exhausted · r refresh', fg: theme.error };
  }

  if (entry.fast !== null) {
    return { text: `fast pace, out in ~${formatDuration(entry.fast.inMs)}`, fg: theme.error };
  }

  return expiring === null
    ? { text: 'no forecast yet', fg: theme.muted }
    : { text: `~${formatPercent(1 - expiring)} used at reset`, fg: theme.muted };
}

/**
 * Picks the quota to steer work to across providers: the one resetting soonest
 * that would still lose a real share of its credits.
 */
function focusOf(entries: ResetEntry[], options: ViewOptions): ResetEntry | null {
  // a quota burning fast right now will not be left over, whatever its average says
  return entries.find((entry) =>
    resetDataNotice(entry.state, options) === null && blockerOf(entry, options) === null &&
    !parentRunsOut(entry, options) && entry.fast === null &&
    (expiringShare(entry.line, options.now, entry.state.lastOk ?? options.now, options.profile ?? null) ?? 0) >= FOCUS_MIN_EXPIRING,
  ) ?? null;
}

/** A single recommendation explains the choice before the comparison. */
function recommendationCard(entries: ResetEntry[], focus: ResetEntry | null, options: ViewOptions, width: number): Card {
  if (focus === null) {
    const hasOldData = entries.some(({ state }) => resetDataNotice(state, options) !== null);
    return card('Use next', [{ text: 'no clear priority', fg: theme.muted }], annotationRows([
      { text: hasOldData ? 'Refresh the flagged providers to compare their quotas.' : 'No unconstrained quota is forecast to leave at least 15% unused.', fg: theme.muted },
    ], width), true);
  }

  const name = annotationRows([
    { ...brandMark(focus.state.id), icon: focus.state.id },
    { text: ` ${entryName(focus)}`, fg: theme.text, bold: true },
  ], width - 2);
  const remaining = `${formatPercent(fraction(focus.line))} used`;
  const last = name.at(-1)!;
  const gap = width - 2 - lineWidth(last) - remaining.length;
  if (gap >= 2) last.push({ text: ' '.repeat(gap) }, { text: remaining, fg: theme.accent, bold: true });
  else name.push([{ text: remaining, fg: theme.accent, bold: true }]);
  const reason = annotationRows([{
    text: `~${formatPercent(expiringShare(focus.line, options.now, focus.state.lastOk ?? options.now, options.profile ?? null)!)} would expire unused`, fg: theme.muted,
  }], width - 2);
  const lines = [...name, ...reason].map((row) => [
    { text: ' ', bg: theme.selectedBg },
    ...row.map((span) => ({ ...span, bg: theme.selectedBg })),
    { text: ' '.repeat(width - 1 - lineWidth(row)), bg: theme.selectedBg },
  ]);
  const reset = resetEta(focus.line, options.now);
  return card('Use next', [{ text: `resets in ${reset}`, fg: theme.accent }], lines, true, { text: '◆', fg: theme.accent });
}

/** All quota bars represent current usage, matching the provider's Forecast. */
function resetUsageColor(entry: ResetEntry, options: ViewOptions, isFocus: boolean): string {
  if (resetDataNotice(entry.state, options) !== null) return theme.dim;
  if (blockerOf(entry, options)?.usedUp) return theme.dim;
  const forecast = forecastFor(entry.line, entry.state, options);
  if (forecast?.kind === 'exhausted' || forecast?.kind === 'runsOut' || entry.fast !== null || fraction(entry.line) >= 0.85) return theme.error;
  return isFocus ? theme.accent : theme.chartBar;
}

/** A readable balance and forecast, with the reset beside the quota name. */
function compactResetRows(entry: ResetEntry, options: ViewOptions, width: number, isFocus: boolean, outlook: Span): Line[] {
  const names = annotationRows([{ text: entryName(entry), fg: theme.text }], width - 2);
  const lines: Line[] = names.map((row, i) => [
    i === 0 ? { text: isFocus ? '◆ ' : '● ', fg: isFocus ? theme.accent : brandColor(entry.state.id), icon: entry.state.id } : { text: '  ' },
    ...row,
  ]);
  const reset: Span = {
    text: `reset ${resetEta(entry.line, options.now)}`,
    fg: isFocus ? theme.accent : theme.muted,
  };
  const last = lines.at(-1)!;
  const gap = width - lineWidth(last) - reset.text.length;
  if (gap >= 2) last.push({ text: ' '.repeat(gap) }, reset);
  else lines.push([{ text: '  ' }, reset]);

  const used = fraction(entry.line);
  const barWidth = Math.max(4, Math.min(40, width - 2));
  lines.push([
    { text: '  ' },
    ...bar(used, barWidth, resetUsageColor(entry, options, isFocus), 'subtle', 1),
  ], ...axisRows(1, barWidth));
  lines.push(...annotationRows([
    { text: `${formatPercent(used)} used`, fg: theme.text, bold: true },
    { text: ' · ', fg: theme.dim }, outlook,
  ], width - 2).map((row) => [{ text: '  ' }, ...row]));
  lines.push([]);
  return lines;
}

/** Compare usage on one scale; keep its ticks below the bars like Forecast. */
function resetsCard(resets: ResetEntry[], focus: ResetEntry | null, options: ViewOptions, width: number): Card {
  const compact = width < 84;
  const nameWidth = Math.min(32, Math.max(18, Math.floor(width * 0.24)), Math.max(18, ...resets.map((entry) => entryName(entry).length)));
  const barWidth = Math.max(10, Math.min(24, Math.floor(width * 0.18)));
  const resetWidth = 10;
  const outlookWidth = width - (2 + nameWidth + 2 + barWidth + 1 + 6 + 3 + resetWidth + 3);
  const inlineOutlook = outlookWidth >= 18;
  const lines: Line[] = [];

  if (!compact) {
    lines.push([
      { text: '  ' + padEnd('Provider / quota', nameWidth) + '  ', fg: theme.muted },
      { text: padEnd('Used', barWidth + 7), fg: theme.muted },
      { text: '   ' + padEnd('Resets in', resetWidth), fg: theme.muted },
      ...(inlineOutlook ? [{ text: '   At this pace', fg: theme.muted }] : []),
    ]);
  }

  for (const group of RESET_GROUPS) {
    const entries = resets.filter(({ line }) => resetGroupOf(line) === group.key);
    if (entries.length === 0) continue;
    if (lines.length > 0) lines.push([]);
    const heading: Line = [
      { text: group.title, fg: theme.text, bold: true },
      { text: ` · ${entries.length}`, fg: theme.muted },
    ];
    const ruleWidth = width - lineWidth(heading) - 2;
    if (ruleWidth > 0) heading.push({ text: '  ' + '─'.repeat(ruleWidth), fg: theme.border });
    lines.push(heading);

    for (const entry of entries) {
      const selected = entry === focus;
      const outlook = expiringText(entry, options);
      if (compact) {
        lines.push(...compactResetRows(entry, options, width, selected, outlook));
        continue;
      }
      const name = entryName(entry);
      const used = fraction(entry.line);
      const row: Line = [
        { text: selected ? '◆ ' : '● ', fg: selected ? theme.accent : brandColor(entry.state.id), icon: entry.state.id },
        { text: shortLabel(name, nameWidth) + '  ', fg: selected ? theme.accent : theme.text },
        ...bar(used, barWidth, resetUsageColor(entry, options, selected), 'subtle', 1),
        { text: ' ' + padStart(formatPercent(used), 6), fg: theme.text },
        { text: '   ' + padStart(resetEta(entry.line, options.now), resetWidth), fg: selected ? theme.accent : theme.muted },
      ];
      const fitsOutlook = inlineOutlook && outlook.text.length <= outlookWidth;
      if (fitsOutlook) row.push({ text: '   ' }, outlook);
      lines.push(row);
      if (name.length > nameWidth || !fitsOutlook) {
        const detail = annotationRows([
          ...(name.length > nameWidth ? [{ text: name + (fitsOutlook ? '' : ' · '), fg: theme.muted }] : []),
          ...(!fitsOutlook ? [outlook] : []),
        ], width - 2);
        lines.push(...detail.map((row) => [{ text: '  ' }, ...row]));
      }
    }
    if (!compact) lines.push(...axisRows(nameWidth + 3, barWidth));
  }

  const pace = options.profile
    ? `Forecasts follow your usual hours, learned from ${options.profile.days} days of history.`
    : 'Forecasts assume the same average pace around the clock until a few days of history teach your usual hours.';
  lines.push([], ...annotationRows([{ text: pace, fg: theme.dim }], width));
  return card('Upcoming resets', [{ text: compact ? '% used · resets by group' : '% used · soonest in each group', fg: theme.muted }], lines, true);
}

/**
 * Builds a provider tab with the quota bars, one trend chart per quota
 * from the local history, and the text and chart lines the provider sends.
 */
export function providerView(
  state: ProviderState,
  history: Sample[],
  window: (typeof WINDOWS)[number],
  options: ViewOptions,
  chartWidth: number,
): View {
  const { now } = options;
  const snapshot = state.snapshot;
  const lines = progressLines(state);

  const strip: Line[] = [
    statusSubtitle(state, options),
    [
      { text: String(lines.length), fg: theme.text, bold: true },
      { text: lines.length === 1 ? ' quota' : ' quotas', fg: theme.muted },
    ],
    state.durationMs !== null
      ? [
          { text: 'probed in ', fg: theme.muted },
          { text: `${(state.durationMs / 1000).toFixed(1)}s`, fg: theme.text },
        ]
      : [],
  ];

  if (snapshot === null) {
    return {
      strip,
      heading: displayName(state),
      headingIcon: state.id,
      headline: null,
      cards: [],
      empty:
        state.error !== null
          ? `✕ ${state.error}   ·   press r to retry`
          : 'Reading the login and asking the provider, the first answer usually takes a few seconds…',
    };
  }

  const primary = [...lines].sort((a, b) => fraction(b) - fraction(a))[0];
  const headline: Line | null = primary
    ? [
        { text: `tightest ${primary.label} `, fg: theme.muted },
        { text: formatPercent(fraction(primary)), fg: levelColor(fraction(primary)), bold: true },
        { text: primary.resetsAt ? `  ${resetIn(primary, now)}  ` : '  ', fg: theme.muted },
        forecastSpan(primary, forecastFor(primary, state, options)),
      ]
    : null;

  const cards: Card[] = [];

  const panelWidth = Math.max(24, (options.terminalWidth ?? 140) - 4);
  const labelWidth = Math.min(MAX_LABEL, Math.max(8, ...lines.map((line) => line.label.length)));
  cards.push(card('Quotas', [
    { text: '% used · ', fg: theme.muted },
    { text: '▁▃▆', fg: theme.chartLine },
    { text: ' 24h', fg: theme.muted },
  ], quotaRows(state, history, options, panelWidth, labelWidth, true), true));


  for (const line of lines) {
    cards.push(trendCard(state.id, line, history, window, now, chartWidth));
  }

  const fit = planFitCard(state, history, options, panelWidth);
  if (fit !== null) cards.push(fit);

  const details: Line[] = [];
  const detailWidth = Math.max(
    0,
    ...snapshot.lines.filter((line) => line.type === 'text' || line.type === 'badge').map((line) => line.label.length),
  );

  for (const line of snapshot.lines) {
    if (line.type === 'text') {
      details.push([
        { text: padEnd(line.label, detailWidth) + '  ', fg: theme.muted },
        { text: line.value, fg: theme.text },
        { text: line.subtitle ? `  ${line.subtitle}` : '', fg: theme.dim },
      ]);
    } else if (line.type === 'badge') {
      details.push([
        { text: padEnd(line.label, detailWidth) + '  ', fg: theme.muted },
        { text: line.text, fg: theme.accent },
      ]);
    }
  }

  if (snapshot.warning) {
    details.push([{ text: `! ${snapshot.warning}`, fg: theme.warn }]);
  }

  if (state.error !== null) {
    details.push([{ text: `! last probe failed, showing older data: ${state.error}`, fg: theme.error }]);
  }

  if (details.length > 0) {
    cards.push(card('Details', [], details, true));
  }

  for (const line of snapshot.lines) {
    if (line.type === 'barChart' && line.points.length > 0) {
      cards.push(barChartCard(line.label, line.points, line.note ?? null, panelWidth));
    }
  }

  return { strip, heading: displayName(state), headingIcon: state.id, headline, cards, empty: null };
}

const DAY_MS = 24 * 3600_000;

/**
 * Quotas that tell whether the plan is the right size: the provider's own
 * coding quotas with a known period.
 */
function fitsOf(state: ProviderState, history: Sample[]) {
  return progressLines(state)
    .filter((line) => !line.auxiliary && !line.detailOnly)
    .flatMap((line) => quotaFit(history, state.id, line) ?? []);
}

/**
 * The fit reads the whole history, so it is worked out once per history
 * and provider state instead of on every one-second tick.
 */
const verdictCache = new WeakMap<Sample[], Map<string, PlanVerdict | null>>();

function verdictOf(state: ProviderState, history: Sample[]): PlanVerdict | null {
  if (state.snapshot === null) return null;
  const key = [state.id, state.snapshot.plan, ...progressLines(state).map((line) => `${line.label}:${line.periodDurationMs}`)].join('\n');
  let cached = verdictCache.get(history);
  if (cached === undefined) verdictCache.set(history, (cached = new Map()));
  if (!cached.has(key)) cached.set(key, planVerdict(state.id, state.snapshot.plan, fitsOf(state, history)));
  return cached.get(key)!;
}

function historyDays(history: Sample[], now: number): number {
  return history.length === 0 ? 0 : Math.max(1, Math.ceil((now - history[0]!.t) / DAY_MS));
}

function verdictSpan(verdict: PlanVerdict, history: Sample[], now: number): Span {
  switch (verdict.kind) {
    case 'learning':
      return { text: `learning · ${verdict.seen} of ${verdict.needed} ${verdict.label} periods seen through to their reset`, fg: theme.dim };
    case 'upgrade':
      return verdict.days
        ? { text: `ran out of ${verdict.label} on ${verdict.ranOut} ${verdict.ranOut === 1 ? 'day' : 'days'} in ${historyDays(history, now)}d · a bigger plan would keep you going`, fg: theme.error }
        : { text: `ran out of ${verdict.label} in ${verdict.ranOut} of ${verdict.periods} periods · a bigger plan would keep you going`, fg: theme.error };
    case 'downsize':
      return {
        text: `${verdict.label} peaked at ${formatPercent(verdict.maxPeak)} · ${verdict.plan ?? `a plan with 1/${verdict.ratio} of the limit`} would still fit`,
        fg: theme.success,
      };
    case 'fits':
      return { text: `${verdict.label} peaked at ${formatPercent(verdict.maxPeak)} and never ran out · the plan fits`, fg: theme.muted };
  }
}

/**
 * How full each quota got before its resets, over the whole history, and
 * what that says about the size of the plan.
 */
function planFitCard(state: ProviderState, history: Sample[], options: ViewOptions, width: number): Card | null {
  const fits = fitsOf(state, history);
  const verdict = verdictOf(state, history);
  if (fits.length === 0 || verdict === null) return null;

  const labelWidth = Math.min(MAX_LABEL, Math.max(8, ...fits.map((fit) => fit.label.length)));
  const barWidth = Math.max(8, Math.min(BAR_WIDTH, width - labelWidth - 40));
  const rows: Line[] = fits.map((fit) => fit.periods === 0
    ? [
        { text: `${shortLabel(fit.label, labelWidth)} `, fg: theme.muted },
        { text: 'no reset seen yet', fg: theme.dim },
      ]
    : [
        { text: `${shortLabel(fit.label, labelWidth)} `, fg: theme.muted },
        ...bar(fit.maxPeak, barWidth, fit.ranOut > 0 ? theme.error : theme.chartBar),
        { text: padStart(formatPercent(fit.maxPeak), 6), fg: theme.text },
        { text: `  median ${formatPercent(fit.medianPeak)}`, fg: theme.muted },
        { text: `  ran out ${fit.ranOut}/${fit.periods}`, fg: fit.ranOut > 0 ? theme.error : theme.dim },
      ]);

  rows.push([], ...annotationRows([verdictSpan(verdict, history, options.now)], width));

  return card('Plan fit', [
    { text: `peak before each reset · last ${historyDays(history, options.now)}d`, fg: theme.muted },
    ...(state.snapshot?.plan ? [{ text: ` · ${state.snapshot.plan}`, fg: theme.dim }] : []),
  ], rows, true);
}

/**
 * The learned profile as a heat strip, one cell pair per hour, so the
 * forecasts' idea of "your hours" can be checked at a glance.
 */
function hoursCard(options: ViewOptions, width: number): Card {
  const profile = options.profile ?? null;
  const title = 'Your hours';

  if (profile === null) {
    return card(title, [{ text: 'activity by hour', fg: theme.muted }], annotationRows([
      { text: 'Learning when you work: after 4 days of history, forecasts stop assuming the same pace around the clock.', fg: theme.dim },
    ], Math.min(width, 60)));
  }

  const labelWidth = 9;
  const cell = width >= labelWidth + 48 ? 2 : 1;
  const heat = (factor: number): Span => {
    const level = factor < 0.35 ? -1 : factor < 0.8 ? 0 : factor < 1.4 ? 1 : factor < 2.2 ? 2 : 3;
    const color = level < 0 ? null : theme.heat[level]!;
    return color === null ? { text: ' '.repeat(cell), bg: theme.chartBg } : { text: '░'.repeat(cell), fg: darkenBar(color, 0.65), bg: color };
  };
  const row = (name: string, offset: number): Line => [
    { text: padEnd(name, labelWidth), fg: theme.muted },
    ...merge(profile.factors.slice(offset, offset + 24).map(heat)),
  ];
  const axis = Array.from({ length: 24 * cell }, () => ' ');
  for (const hour of [0, 6, 12, 18]) {
    const label = String(hour);
    for (let i = 0; i < label.length; i++) axis[hour * cell + i] = label[i]!;
  }
  const current = new Date(options.now);
  const nowAt = current.getHours() * cell;
  const marker = Array.from({ length: 24 * cell }, (_, i) => (i === nowAt ? '▲' : ' ')).join('').trimEnd();
  const today = current.getDay() === 0 || current.getDay() === 6 ? 'weekends' : 'weekdays';

  return card(title, [{ text: `activity by hour · ${profile.days} days learned`, fg: theme.muted }], [
    row('weekdays', 0),
    row('weekends', 24),
    [{ text: ' '.repeat(labelWidth) + axis.join('').trimEnd(), fg: theme.dim }],
    [{ text: ' '.repeat(labelWidth) + marker, fg: theme.accent }, { text: ` now (${today})`, fg: theme.dim }],
  ]);
}

function barChartCard(
  title: string,
  points: { label: string; value: number; valueLabel?: string | null }[],
  note: string | null,
  availableWidth: number,
): Card {
  const max = Math.max(...points.map((point) => point.value), 0);
  const labelWidth = Math.min(MAX_LABEL, Math.floor(availableWidth / 3), Math.max(...points.map((point) => point.label.length)));
  const values = points.map((point) => point.valueLabel ?? String(point.value));
  const valueWidth = Math.max(...values.map((value) => value.length));
  const width = Math.max(8, Math.min(BAR_WIDTH, availableWidth - labelWidth - valueWidth - 2));

  const rows: Line[] = points.map((point, i) => {
    return [
      { text: shortLabel(point.label, labelWidth) + ' ', fg: theme.muted },
      ...bar(max > 0 ? point.value / max : 0, width, point.value === max ? theme.accent : theme.chartBar),
      { text: ' ' + padStart(values[i]!, valueWidth), fg: point.value === 0 ? theme.dim : theme.text },
    ];
  });

  return card(title, [{ text: note ?? '', fg: theme.muted }], rows);
}

const MIN_TREND_POINTS = 4;

/**
 * Says in words how a quota moved over the window, so the chart has a
 * text summary that does not depend on reading the line.
 */
function trendSummary(samples: Sample[], windowLabel: string): Span {
  const delta = (samples.at(-1)!.v - samples[0]!.v) * 100;

  if (Math.abs(delta) < 0.5) {
    return { text: `→ steady over ${windowLabel}`, fg: theme.muted };
  }

  return delta > 0
    ? { text: `↑ +${delta.toFixed(1)} pts over ${windowLabel}`, fg: theme.accent }
    : { text: `↓ ${delta.toFixed(1)} pts over ${windowLabel} (reset)`, fg: theme.success };
}

/**
 * Plots the stored samples of one quota over the trend window. Samples are
 * bucketed into one column each and a column without samples carries the
 * previous value forward, so a gap while the TUI was closed draws flat.
 */
function trendCard(
  providerId: string,
  line: ProgressLine,
  history: Sample[],
  window: (typeof WINDOWS)[number],
  now: number,
  chartWidth: number,
): Card {
  const start = now - window.ms;
  const samples = windowSamples(history, providerId, line.label, start);
  const subtitle: Line = [{ text: `% used, last ${window.label}`, fg: theme.muted }];
  const columns = Math.max(20, chartWidth - 16);
  const current = fraction(line);

  // a line through fewer than four points suggests a trend that is not there
  if (samples.length < MIN_TREND_POINTS) {
    return card(`Trend · ${line.label}`, subtitle, [
      [
        { text: formatPercent(current), fg: levelColor(current), bold: true },
        { text: ' used now', fg: theme.muted },
      ],
      [
        {
          text: `${samples.length} of ${MIN_TREND_POINTS} readings collected, the chart appears once there are enough`,
          fg: theme.dim,
        },
      ],
    ]);
  }

  subtitle.push({ text: '  ' }, trendSummary(samples, window.label));

  const first = samples[0]!.t;
  const from = Math.max(start, first);
  const span = Math.max(1, now - from);
  const series: number[] = [];
  let cursor = 0;
  let last = samples[0]!.v * 100;

  for (let col = 0; col < columns; col++) {
    const bucketEnd = from + ((col + 1) / columns) * span;

    while (cursor < samples.length && samples[cursor]!.t <= bucketEnd) {
      last = samples[cursor]!.v * 100;
      cursor++;
    }

    series.push(last);
  }

  const peak = Math.max(...series);
  // Six steps and an amber endpoint mirror pr-stats' trend charts.
  const height = 6;
  const top = Math.max(30, Math.ceil(peak / 30) * 30);
  const plot = asciichart.plot(series, {
    height,
    min: 0,
    max: top,
    format: (value: number) => padStart(`${Math.round(value)}%`, 5),
  });

  const endpointRow = height - Math.round((series.at(-1)! / top) * height);
  const plotRows = plot.split('\n');
  // every row's plot area padded to one width, so the track forms a rectangle
  const plotWidth = Math.max(...plotRows.map((row) => row.length - row.search(/[┤┼]/) - 1));
  const rows: Line[] = plotRows.map((row, i) => {
    const axis = row.search(/[┤┼]/);

    if (axis < 0) {
      return [{ text: row, fg: theme.chartLine }];
    }

    return [
      { text: row.slice(0, axis + 1), fg: theme.muted },
      { text: padEnd(row.slice(axis + 1), plotWidth), fg: theme.chartLine, bg: theme.chartBg },
      ...(i === endpointRow ? [{ text: ` ${formatPercent(series.at(-1)! / 100)}`, fg: theme.accent }] : []),
    ];
  });

  const startLabel = new Date(from).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const gap = Math.max(1, columns - startLabel.length - 3);
  rows.push([{ text: '       ' + startLabel + ' '.repeat(gap) + 'now', fg: theme.dim }]);

  subtitle.push({ text: `  peak ${Math.round(peak)}%`, fg: theme.dim });

  return card(`Trend · ${line.label}`, subtitle, rows);
}

/**
 * What the footer mode shows: a line for the recommendation and a line per
 * provider, both led by the provider's logo where the terminal draws it,
 * and the keys of the recommended and fast-burning quotas, which the
 * footer compares between ticks to log changes to the scrollback.
 */
export interface FooterView {
  lines: Line[];
  focus: { key: string; text: Line } | null;
  fast: { key: string; text: Line }[];
}

function entryKey(entry: { state: ProviderState; line: ProgressLine }): string {
  return `${entry.state.id}\n${entry.line.label}`;
}

export function footerView(states: ProviderState[], history: Sample[], options: ViewOptions, width: number): FooterView {
  const { now } = options;
  const entries: ResetEntry[] = states
    .flatMap((state) => progressLines(state).filter((line) => !line.detailOnly).map((line) => ({ state, line })))
    .filter(({ line }) => !line.auxiliary && Number.isFinite(line.used) && line.used >= 0 &&
      Number.isFinite(line.limit) && line.limit > 0 && nextResetAt(line, now) !== null)
    .sort((a, b) => nextResetAt(a.line, now)! - nextResetAt(b.line, now)!)
    .map(({ state, line }) => ({ state, line, fast: fastBurnFor(line, state, history, options) }));
  const focus = focusOf(entries, options);
  const fast = entries.filter((entry) => entry.fast !== null && resetDataNotice(entry.state, options) === null);

  const lines: Line[] = [focus === null
    ? [{ text: '◆ ', fg: theme.dim }, { text: 'no clear priority', fg: theme.muted }]
    : [
        { text: '◆ Use next  ', fg: theme.accent },
        { text: '● ', fg: brandColor(focus.state.id), icon: focus.state.id },
        { text: entryName(focus), fg: theme.text, bold: true },
        { text: ` · ~${formatPercent(expiringShare(focus.line, now, focus.state.lastOk ?? now, options.profile ?? null)!)} would expire`, fg: theme.muted },
        { text: ` · resets in ${resetEta(focus.line, now)}`, fg: theme.accent },
      ]];

  const nameWidth = Math.min(16, Math.max(6, ...states.map((state) => displayName(state).length)));
  // one label width for every row, so the bars line up in columns
  const labelWidth = Math.min(12, Math.max(4, ...states.flatMap((state) => progressLines(state).map((line) => line.label.length))));
  const resetWidth = Math.max(0, ...states.flatMap((state) => progressLines(state).map((line) => resetIn(line, now).length)));
  for (const state of states) {
    // a logo takes one cell more than the dot, which the width leaves room for
    const row: Line = [
      { text: '● ', fg: brandColor(state.id), icon: state.id },
      { text: padEnd(displayName(state), nameWidth), fg: theme.text },
    ];
    const quotas = progressLines(state).filter((line) => !line.auxiliary && !line.detailOnly);

    if (state.snapshot === null) {
      row.push(state.error !== null
        ? { text: `  ✕ ${state.error}`, fg: theme.error }
        : { text: '  ◌ probing…', fg: theme.muted });
    } else if (state.error !== null || resetDataNotice(state, options) === 'stale data · r refresh') {
      row.push({ text: '  ! stale', fg: theme.warn });
    }

    for (const line of state.snapshot === null ? [] : quotas) {
      const used = fraction(line);
      const forecast = forecastFor(line, state, options);
      const burst = fastBurnFor(line, state, history, options);
      const alarm = burst !== null || forecast?.kind === 'runsOut' || forecast?.kind === 'exhausted';
      const segment: Line = [
        { text: `  ${shortLabel(line.label, labelWidth)} `, fg: theme.muted },
        ...bar(used, 8, alarm ? theme.error : barColor(used, false)),
        { text: padStart(formatPercent(used), 5), fg: theme.text },
        { text: ` ${resetIn(line, now).padEnd(resetWidth)} `, fg: theme.dim },
        { text: burst !== null ? '↑' : ' ', fg: theme.error },
      ];
      if (lineWidth(row) + 1 + lineWidth(segment) > width) {
        row.push({ text: ' …', fg: theme.dim });
        break;
      }
      row.push(...segment);
    }
    lines.push(merge(row));
  }

  return {
    lines,
    focus: focus === null ? null : { key: entryKey(focus), text: [
      { text: '◆ Use next ', fg: theme.accent },
      { text: entryName(focus), fg: theme.text, bold: true },
      { text: ` · ~${formatPercent(expiringShare(focus.line, now, focus.state.lastOk ?? now, options.profile ?? null)!)} would expire in ${resetEta(focus.line, now)}`, fg: theme.muted },
    ] },
    fast: fast.map((entry) => ({ key: entryKey(entry), text: [
      { text: entryName(entry), fg: theme.text },
      { text: ' ' },
      fastSpan(entry.fast!),
    ] })),
  };
}

/**
 * Changes between two snapshots of a provider worth a line in the
 * footer's log: resets, and quotas crossing half, 80%, or their limit.
 */
export function snapshotEvents(name: string, previous: ProviderSnapshot | null, next: ProviderSnapshot): Line[] {
  const events: Line[] = [];
  const before = new Map((previous?.lines ?? []).flatMap((line) => (line.type === 'progress' ? [[line.label, fraction(line)] as const] : [])));

  for (const line of next.lines) {
    if (line.type !== 'progress' || line.auxiliary || line.detailOnly) continue;
    const used = fraction(line);
    const was = before.get(line.label);
    const quota = line.label.startsWith(name) ? line.label : `${name} ${line.label}`;

    if (was === undefined) {
      // the first reading only reports what already needs attention
      if (previous === null && used >= 1) {
        events.push([{ text: `✕ ${quota} is used up`, fg: theme.error }, ...resetNote(line)]);
      }
      continue;
    }

    if (used < was - 0.02 && was >= 0.05) {
      events.push([{ text: `↻ ${quota} reset`, fg: theme.success }, { text: ` · was ${formatPercent(was)}, now ${formatPercent(used)}`, fg: theme.muted }]);
      continue;
    }

    const crossed = [1, 0.8, 0.5].find((mark) => was < mark && used >= mark);
    if (crossed === 1) {
      events.push([{ text: `✕ ${quota} ran out`, fg: theme.error }, ...resetNote(line)]);
    } else if (crossed !== undefined) {
      events.push([{ text: `▲ ${quota} passed ${formatPercent(crossed)}`, fg: crossed >= 0.8 ? theme.accent : theme.text }, ...resetNote(line)]);
    }
  }

  return events;
}

function resetNote(line: ProgressLine): Line {
  return line.resetsAt === null ? [] : [{ text: ` · resets ${resetAt(line, true)}`, fg: theme.muted }];
}
