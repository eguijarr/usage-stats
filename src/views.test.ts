import { describe, expect, test } from 'bun:test';
import { forecastOf, formatDuration, formatPercent, formatUsed } from './format';
import type { ProgressLine } from './providers/types';
import { overviewView, providerView, WINDOWS, type ProviderState } from './views';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 86_400_000;

function weekly(used: number, daysLeft: number): ProgressLine {
  return {
    type: 'progress',
    label: 'Weekly',
    used,
    limit: 100,
    format: { kind: 'percent' },
    resetsAt: new Date(NOW + daysLeft * DAY).toISOString(),
    periodDurationMs: 7 * DAY,
  };
}

function state(id: string, lines: ProgressLine[], error: string | null = null): ProviderState {
  return {
    id,
    snapshot: { providerId: id, displayName: id, plan: 'Pro', warning: null, lines },
    error,
    probing: false,
    lastOk: NOW,
    durationMs: 1000,
    probeStartedAt: null,
  };
}

const OPTIONS = { now: NOW, staleAfterMs: 10 * 60_000 };

const text = (line: { text: string }[]) => line.map((span) => span.text).join('');

describe('format', () => {
  test('durations', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(2 * 3600_000 + 15 * 60_000)).toBe('2h 15m');
    expect(formatDuration(3 * DAY + 4 * 3600_000)).toBe('3d 4h');
  });

  test('used amounts per unit', () => {
    expect(formatUsed({ ...weekly(3.1, 1), limit: 25, format: { kind: 'dollars' } })).toBe('$3.10 / $25.00');
    expect(formatUsed({ ...weekly(120, 1), limit: 500, format: { kind: 'count', suffix: 'req' } })).toBe('120 / 500 req');
  });
});

describe('forecast', () => {
  test('a quota burning faster than time runs out before its reset', () => {
    // half the week gone, 80% used: the last 20% lasts 3.5d * 20 / 80
    const forecast = forecastOf(weekly(80, 3.5), NOW);
    expect(forecast?.kind).toBe('runsOut');
    expect(forecast?.kind === 'runsOut' && Math.round(forecast.inMs / 3600_000)).toBe(21);
  });

  test('a slower quota lands below its limit at the reset', () => {
    expect(forecastOf(weekly(25, 3.5), NOW)).toEqual({ kind: 'atReset', fraction: 0.5 });
    expect(forecastOf(weekly(100, 3.5), NOW)).toEqual({ kind: 'exhausted' });
    // too early in the period to extrapolate
    expect(forecastOf(weekly(3, 6.9), NOW)).toBeNull();
  });

  test('small percents keep a decimal', () => {
    expect(formatPercent(0.046)).toBe('4.6%');
    expect(formatPercent(0.14)).toBe('14%');
    expect(formatPercent(0.05)).toBe('5%');
    expect(formatPercent(0.00008553)).toBe('<0.1%');
  });
});

describe('views', () => {
  test('overview leads with a recommendation, counts errors and preserves every provider card', () => {
    const view = overviewView([state('a', [weekly(20, 3)]), state('b', [weekly(70, 3)]), state('c', [], 'auth')], [], OPTIONS);

    expect(text(view.strip[0]!)).toContain('1 failing');
    expect(text(view.strip[1]!)).toBe('1 quota at risk');
    expect(view.cards.map((c) => c.title)).toEqual(['Use next', 'Upcoming resets', 'a', 'b', 'c']);
    expect(view.cards[0]!.lines.map(text).join('\n')).toContain('a Weekly');
    for (const id of ['a', 'b']) {
      const card = view.cards.find((card) => card.title === id)!;
      expect(card.lines.map(text).join('\n')).toContain('Weekly');
      expect(card.lines.map(text).join('\n')).toContain('100%');
    }
  });

  test('errors say how to retry and old data is flagged stale', () => {
    const view = overviewView(
      [state('a', [], 'Not logged in'), { ...state('b', [weekly(20, 3)]), lastOk: NOW - 11 * 60_000 }],
      [],
      OPTIONS,
    );

    expect(text(view.cards.find((card) => card.title === 'a')!.lines.at(-1)!)).toBe('✕ Not logged in  (r retries)');
    expect(text(view.cards.find((card) => card.title === 'b')!.subtitle)).toContain('! stale · updated 11m ago');
  });

  test('keeps model quotas, non-resetting balances and extra information below upcoming resets', () => {
    const provider = state('codex', [weekly(14, 3), { ...weekly(89, 1), label: 'Spark', resetsAt: null }]);
    provider.snapshot!.lines.push({ type: 'text', label: 'Credits', value: '25.75 credits' });
    const view = overviewView([provider], [], OPTIONS);
    const detail = view.cards.find((card) => card.title === 'codex')!;
    expect(view.cards.indexOf(detail)).toBeGreaterThan(view.cards.findIndex((card) => card.title === 'Upcoming resets'));
    const content = detail.lines.map(text).join('\n');
    for (const value of ['Weekly', 'Spark', '89%', 'Credits', '25.75 credits']) expect(content).toContain(value);
  });

  test('provider trend shows a stat until four readings exist, then plots with a summary', () => {
    const provider = state('a', [weekly(40, 3)]);
    const sparse = providerView(provider, [], WINDOWS[1]!, OPTIONS, 60);
    expect(text(sparse.cards[1]!.lines[1]!)).toContain('0 of 4 readings');

    const samples = [0.1, 0.2, 0.3, 0.4].map((v, i) => ({ t: NOW - (4 - i) * 3600_000, p: 'a', l: 'Weekly', v }));
    const plotted = providerView(provider, samples, WINDOWS[1]!, OPTIONS, 60);
    expect(text(plotted.cards[1]!.subtitle)).toContain('↑ +30.0 pts over 24h');
    expect(plotted.cards[1]!.lines.length).toBe(8);
  });

  test('providerView sets headingIcon and includes provider icon in the strip', () => {
    const provider = state('claude', [weekly(40, 3)]);
    const view = providerView(provider, [], WINDOWS[1]!, OPTIONS, 60);
    expect(view.headingIcon).toBe('claude');
    expect(view.heading).toBe('claude');
    expect(view.strip[0]?.[0]?.icon).toBe('claude');
  });
});

describe('icons', () => {
  test('every provider ships a logo', async () => {
    const { existsSync } = await import('node:fs');
    const { DEFAULT_PROVIDERS } = await import('./providers');
    const { iconPath } = await import('./components/ProviderIcon');

    for (const id of DEFAULT_PROVIDERS) {
      expect(existsSync(iconPath(id))).toBe(true);
    }
  });
});

describe('logo protocol', () => {
  const caps = (name: string, kitty: boolean, sixel = false) =>
    ({ kitty_graphics: kitty, sixel, multiplexer: 'none', terminal: { name, version: '', from_xtversion: true } }) as never;

  test('draws logos where the terminal renders images, the dot elsewhere', async () => {
    const { chooseImageProtocol, setIconMode } = await import('./components/ProviderIcon');
    const tmux = process.env.TMUX;
    delete process.env.TMUX;

    setIconMode('auto');
    expect(chooseImageProtocol(caps('ghostty', true), true)).toBe('kitty');
    expect(chooseImageProtocol(caps('WindowsTerminal', false, true), true)).toBe('sixel');
    // sixel is drawn by our overlay, so a terminal that hides its pixel size still gets logos
    expect(chooseImageProtocol(caps('WindowsTerminal', false, true), false)).toBe('sixel');
    // answers the kitty query but never draws, so the dot stays
    expect(chooseImageProtocol(caps('libghostty', true), true)).toBeNull();
    expect(chooseImageProtocol(caps('xterm', false), true)).toBeNull();

    setIconMode('always');
    expect(chooseImageProtocol(caps('libghostty', true), true)).toBe('kitty');

    setIconMode('off');
    expect(chooseImageProtocol(caps('ghostty', true), true)).toBeNull();

    setIconMode('auto');
    if (tmux !== undefined) process.env.TMUX = tmux;
  });
});

describe('sixel', () => {
  test('encodes a logo at the requested cell size with a transparent background', async () => {
    const { readFileSync } = await import('node:fs');
    const { decodePng, encodeSixel } = await import('./sixel');
    const { iconPath } = await import('./components/ProviderIcon');

    const image = decodePng(readFileSync(iconPath('claude')));
    expect([image.width, image.height]).toEqual([64, 64]);

    const sixel = encodeSixel(image, 20, 20, '#de7356');
    expect(sixel.startsWith('\x1bP0;1;0q"1;1;20;20#1;2;87;45;34#1')).toBe(true);
    expect(sixel.endsWith('\x1b\\')).toBe(true);
    // four bands of six rows cover 20 pixels
    expect(sixel.split('-').length - 1).toBe(4);

    const sixelWithBg = encodeSixel(image, 20, 20, '#de7356', '#483e35');
    expect(sixelWithBg.includes('#0;2;28;24;21')).toBe(true);
    expect(sixelWithBg.includes('#1;2;87;45;34')).toBe(true);
    expect(sixelWithBg.endsWith('\x1b\\')).toBe(true);
  });
});

describe('upcoming resets', () => {
  const HOUR = 3600_000;
  const quota = (label: string, used: number, periodMs: number, leftMs: number): ProgressLine => ({
    type: 'progress',
    label,
    used,
    limit: 100,
    format: { kind: 'percent' },
    resetsAt: new Date(NOW + leftMs).toISOString(),
    periodDurationMs: periodMs,
  });

  test('groups by cadence, sorts soonest first, and marks where credits would expire', async () => {
    const { expiringShare, resetGroupOf } = await import('./format');
    // 4h of a 5h session gone at 10%: ~87% of it would expire
    const session = quota('Session', 10, 5 * HOUR, 1 * HOUR);
    // 4 of 7 days gone at 47%: lands near 82%, ~18% would expire
    const weekly = quota('Weekly', 47, 7 * DAY, 3 * DAY);
    // Cursor-style month, 3 of 30 days gone at 14%: runs out first, nothing expires
    const monthly = quota('Total usage', 14, 30 * DAY, 27 * DAY);

    expect([session, weekly, monthly].map(resetGroupOf)).toEqual(['session', 'weekly', 'monthly']);
    expect(resetGroupOf({ ...monthly, periodDurationMs: 100 * DAY })).toBe('other');
    expect(resetGroupOf({ ...monthly, label: 'Primary limit', periodDurationMs: null })).toBe('other');
    expect(Math.round(expiringShare(session, NOW)! * 100)).toBe(88);
    expect(expiringShare(monthly, NOW)).toBe(0);

    const view = overviewView(
      [state('claude', [session, quota('Weekly', 90, 7 * DAY, 5 * DAY)]), state('codex', [weekly]), state('cursor', [monthly])],
      [],
      { ...OPTIONS, terminalWidth: 160 },
    );
    const resets = view.cards.find((c) => c.title === 'Upcoming resets')!;
    const rows = resets.lines.map(text);

    expect(rows.filter((row) => /^(Session|Weekly|Monthly) /.test(row)).map((row) => row.split(' ')[0])).toEqual(['Session', 'Weekly', 'Monthly']);
    // weekly: codex (3d) before claude (5d)
    expect(rows.findIndex((row) => row.includes('codex Weekly'))).toBeLessThan(rows.findIndex((row) => row.includes('claude Weekly')));
    expect(rows.find((row) => row.includes('cursor Total usage'))).toContain('runs out in');
    // overall priority: the session, which expires first with most left
    const recommendation = view.cards.find((c) => c.title === 'Use next')!;
    expect(text(recommendation.subtitle)).toContain('resets in 1h');
    expect(recommendation.lines.map(text).join('\n')).toContain('claude Session');
    expect(recommendation.lines.map(text).join('\n')).toContain('10% used');
    expect(rows.find((row) => row.includes('claude Session'))).toContain('~13% used at reset');
    expect(rows.filter((row) => row.startsWith('◆ ')).length).toBe(1);

    const resetIcons = resets.lines.flat().filter((s) => s.icon !== undefined).map((s) => s.icon);
    expect(resetIcons).toEqual(['claude', 'codex', 'claude', 'cursor']);
    expect(recommendation.lines.flat().find((s) => s.icon !== undefined)?.icon).toBe('claude');

    const compactResets = overviewView(
      [state('claude', [session])],
      [],
      { ...OPTIONS, terminalWidth: 70 },
    ).cards.find((c) => c.title === 'Upcoming resets')!;
    expect(compactResets.lines.flat().find((s) => s.icon !== undefined)?.icon).toBe('claude');

    // a declared shared limit prevents recommending a constrained quota
    const blocked = overviewView(
      [state('devin', [{ ...quota('Daily quota', 10, DAY, 2 * HOUR), dependsOn: ['Weekly quota'] }, quota('Weekly quota', 100, 7 * DAY, 2 * HOUR)])],
      [],
      { ...OPTIONS, terminalWidth: 160 },
    ).cards.find((c) => c.title === 'Upcoming resets')!;
    expect(blocked.lines.map(text).find((row) => row.includes('devin Daily quota'))).toContain('blocked by Weekly quota');
    expect(blocked.lines.some((row) => text(row).startsWith('◆ '))).toBe(false);
  });

  const resetsFor = (states: ProviderState[]) => overviewView(states, [], { ...OPTIONS, terminalWidth: 160 })
    .cards.find((card) => card.title === 'Upcoming resets')!;

  test('keeps current balance separate from an unavailable forecast', async () => {
    const { expiringShare } = await import('./format');
    const early = quota('Session', 3, 5 * HOUR, 4.99 * HOUR);
    const noPeriod = { ...quota('Custom quota', 10, DAY, HOUR), periodDurationMs: null };
    expect(expiringShare(early, NOW)).toBeNull();
    expect(expiringShare(noPeriod, NOW)).toBeNull();
    const card = resetsFor([state('claude', [early, noPeriod])]);
    expect(card.lines.some((row) => text(row).startsWith('◆ '))).toBe(false);
    const earlyRow = card.lines.map(text).find((row) => row.includes('claude Session'))!;
    const unknownRow = card.lines.map(text).find((row) => row.includes('claude Custom quota'))!;
    expect(earlyRow).toContain('3%');
    expect(earlyRow).toContain('no forecast');
    expect(unknownRow).toContain('10%');
    expect(unknownRow).toContain('no forecast');
  });

  test('an exhausted model pool does not block unrelated quotas', () => {
    const session = { ...quota('Session', 10, 5 * HOUR, HOUR), dependsOn: ['Weekly'] };
    const weekly = { ...quota('Weekly', 20, 7 * DAY, 3 * DAY), dependsOn: ['Session'] };
    const scoped = { ...quota('Sonnet', 100, 7 * DAY, 3 * DAY), dependsOn: ['Session', 'Weekly'] };
    const card = resetsFor([state('claude', [session, weekly, scoped])]);
    expect(card.lines.map(text).find((row) => row.startsWith('◆ '))).toContain('claude Session');
    expect(card.lines.map(text).join('\n')).not.toContain('blocked by Sonnet');
  });

  test('auxiliary allowances like Cursor\'s Grok bot stay out of the planning', () => {
    const grok = { ...quota('Grok Bot usage', 10, 7 * DAY, 2 * DAY), auxiliary: true };
    const states = [state('cursor', [grok, quota('Total usage', 50, 30 * DAY, 15 * DAY)])];
    const view = overviewView(states, [], { ...OPTIONS, terminalWidth: 160 });

    expect(resetsFor(states).lines.map(text).join('\n')).not.toContain('Grok');
    expect(view.cards.find((c) => c.title === 'cursor')!.lines.map(text).join('\n')).toContain('Grok');
  });

  test('a total constrains its model shares without making the reverse dependency', () => {
    const total = quota('Total usage', 90, 30 * DAY, 15 * DAY);
    const models = { ...quota('Other Models', 10, 30 * DAY, 15 * DAY), dependsOn: ['Total usage'] };
    const capped = resetsFor([state('cursor', [total, models])]);
    expect(capped.lines.map(text).join('\n')).toContain('may hit Total usage first');
    expect(capped.lines.some((row) => text(row).startsWith('◆ '))).toBe(false);

    const independentTotal = resetsFor([state('cursor', [{ ...total, used: 10 }, { ...models, used: 100 }])]);
    expect(independentTotal.lines.map(text).find((row) => row.startsWith('◆ '))).toContain('cursor Total usage');
    expect(independentTotal.lines.map(text).join('\n')).not.toContain('blocked by Other Models');
  });

  test('excludes stale data and provider warnings from the priority', () => {
    const soon = quota('Session', 10, 5 * HOUR, HOUR);
    const later = quota('Session', 10, 5 * HOUR, 2 * HOUR);
    const old = { ...state('old', [soon]), lastOk: NOW - 11 * 60_000 };
    const warned = state('warned', [soon]);
    warned.snapshot!.warning = 'Cached response';
    const card = resetsFor([old, warned, state('fresh', [later])]);
    expect(card.lines.map(text).find((row) => row.startsWith('◆ '))).toContain('fresh Session');
    expect(card.lines.map(text).join('\n')).toContain('stale data · r refresh');
    expect(card.lines.map(text).join('\n')).toContain('check provider warning');
  });

  test('does not project a temporary parent limit beyond its own reset', () => {
    const session = quota('Session', 80, 5 * HOUR, 3 * HOUR);
    const weekly = { ...quota('Weekly', 20, 7 * DAY, 3 * DAY), dependsOn: ['Session'] };
    const card = resetsFor([state('claude', [session, weekly])]);
    expect(card.lines.map(text).find((row) => row.startsWith('◆ '))).toContain('claude Weekly');
    expect(card.lines.map(text).join('\n')).not.toContain('may hit Session first');
    const expired = resetsFor([state('claude', [{ ...session, used: 100, resetsAt: new Date(NOW - HOUR).toISOString() }, weekly])]);
    expect(expired.lines.map(text).find((row) => row.startsWith('◆ '))).toContain('claude Weekly');
  });
});

describe('reset comparison', () => {
  const HOUR = 3600_000;
  const quota = (label: string, used: number, periodMs: number, leftMs: number): ProgressLine => ({
    type: 'progress',
    label,
    used,
    limit: 100,
    format: { kind: 'percent' },
    resetsAt: new Date(NOW + leftMs).toISOString(),
    periodDurationMs: periodMs,
  });
  const resets = (states: ProviderState[], width = 160) =>
    overviewView(states, [], { ...OPTIONS, terminalWidth: width }).cards.find((c) => c.title === 'Upcoming resets')!;

  test('separates used quota, reset time and forecast', () => {
    const view = overviewView([state('claude', [quota('Weekly', 25, 7 * DAY, 3 * DAY)])], [], { ...OPTIONS, terminalWidth: 160 });
    const header = text(resets([state('claude', [quota('Weekly', 25, 7 * DAY, 3 * DAY)])]).lines[0]!);

    expect(view.cards[0]!.title).toBe('Use next');
    expect(view.cards[1]!.title).toBe('Upcoming resets');
    expect(view.cards.some((c) => c.title === 'Usage distribution')).toBe(false);
    for (const label of ['Used', 'Resets in', 'At this pace']) expect(header).toContain(label);
  });

  test('reports usage separately from exhaustion and shared constraints', () => {
    const rows = resets([
      state('claude', [
        // 1h of 5h gone at 40%: runs out after another 1.5h, 2.5h before the reset
        quota('Session', 40, 5 * HOUR, 4 * HOUR),
        // half a week gone at 25%: lasts until the reset
        quota('Weekly', 25, 7 * DAY, 3.5 * DAY),
      ]),
      state('devin', [quota('Weekly quota', 100, 7 * DAY, 2 * DAY)]),
    ]).lines.map(text);
    const row = (name: string) => rows.find((r) => r.includes(name))!;

    expect(row('claude Session')).toContain('40%');
    expect(row('claude Session')).toContain('runs out in ~1h 30m');
    expect(row('claude Weekly')).toContain('25%');
    expect(row('claude Weekly')).toContain('~50% used at reset');
    // exhausted: the entire quota is consumed until the reset
    expect(row('devin Weekly quota')).toContain('100%');
    expect(row('devin Weekly quota')).toContain('fully used');

    // Remaining quota is not available while a shared session blocks it.
    const blocked = resets([
      state('codex', [
        { ...quota('Weekly', 60, 7 * DAY, 3 * DAY), dependsOn: ['Session'] },
        quota('Session', 100, 5 * HOUR, 4 * HOUR),
      ]),
    ]).lines.map(text).find((r) => r.includes('codex Weekly'))!;
    expect(blocked).toContain('60%');
    expect(blocked).toContain('blocked by Session');
  });

  test('compact panels keep used percentages and the scale below the bars', () => {
    const rows = resets([state('claude', [quota('Weekly', 25, 7 * DAY, 3.5 * DAY)])], 70).lines.map(text);

    expect(rows.join('\n')).toContain('25% used');
    const barIndex = resets([state('claude', [quota('Weekly', 25, 7 * DAY, 3.5 * DAY)])], 70)
      .lines.findIndex((line) => line.some((span) => span.bg));
    expect(rows[barIndex + 1]).toContain('╵');
    expect(rows[barIndex + 2]).toContain('100%');
    expect(rows.join('\n')).toContain('~50% used at reset');
  });

  test('stale, warning and unknown forecasts do not claim predicted exhaustion', () => {
    const fast = quota('Session', 40, 5 * HOUR, 4 * HOUR);
    const old = { ...state('old', [fast]), lastOk: NOW - 11 * 60_000 };
    const warning = state('warning', [fast]);
    warning.snapshot!.warning = 'Cached data';
    const unknown = state('unknown', [{ ...fast, periodDurationMs: null }]);
    const rows = resets([old, warning, unknown]).lines.map(text);
    for (const id of ['old', 'warning', 'unknown']) {
      const row = rows.find((row) => row.includes(`${id} Session`))!;
      expect(row).toContain('40%');
      expect(row).not.toContain('runs out');
      expect(row).not.toContain('used at reset');
    }
  });

  test('chooses the earliest predicted shared limit and agrees with the text', () => {
    const own = { ...quota('Models', 70, 30 * DAY, 15 * DAY), dependsOn: ['Slow', 'Fast'] };
    const rows = resets([state('cursor', [own, quota('Slow', 80, 30 * DAY, 15 * DAY), quota('Fast', 90, 30 * DAY, 15 * DAY)])]).lines.map(text);
    const row = rows.find((row) => row.includes('cursor Models'))!;
    expect(row).toContain('may hit Fast first');
    expect(row).toContain('70%');
  });

  test('a quota blocked by several exhausted limits waits for the last refill', () => {
    const own = { ...quota('Models', 10, 30 * DAY, 15 * DAY), dependsOn: ['Session', 'Weekly'] };
    const card = resets([state('cursor', [own, quota('Session', 100, 5 * HOUR, 4 * HOUR), quota('Weekly', 100, 7 * DAY, 4 * DAY)])]);
    expect(card.lines.map(text).find((row) => row.includes('cursor Models'))).toContain('blocked by Weekly');
    expect(card.lines.some((row) => text(row).startsWith('◆ '))).toBe(false);
  });

  test('keeps exhaustion and reset times distinct when they are close together', () => {
    const row = resets([state('near', [quota('Session', 50.1, 5 * HOUR, 2.5 * HOUR)])]).lines.map(text).find((row) => row.includes('near Session'))!;
    expect(row).toContain('runs out in ~2h 29m');
    expect(row).toContain('2h 30m');
  });

  test('an elapsed estimate asks for a refresh rather than claiming confirmed exhaustion', () => {
    const fast = state('fast', [quota('Session', 99.99, 5 * HOUR, 4 * HOUR)]);
    const card = overviewView([fast], [], { ...OPTIONS, now: NOW + 60_000, terminalWidth: 160 }).cards.find((c) => c.title === 'Upcoming resets')!;
    expect(card.lines.map(text).join('\n')).toContain('may be exhausted · r refresh');
  });

  test('shows full durations beyond a month without capping them', () => {
    // Half a 100-day period used at 60%: exhaustion is 33d away, outside the axis.
    const row = resets([state('long', [quota('Custom quota', 60, 100 * DAY, 50 * DAY)])]).lines.map(text).find((row) => row.includes('long Custom quota'))!;
    expect(row).toContain('50d');
    expect(row).toContain('runs out in ~33d 8h');
  });
});

describe('detail-only quotas', () => {
  test("stay out of the overview but keep their place on the provider's tab", () => {
    const quota = (label: string, used: number, detailOnly = false): ProgressLine => ({
      type: 'progress',
      label,
      used,
      limit: 100,
      format: { kind: 'percent' },
      resetsAt: new Date(NOW + 3 * 3600_000).toISOString(),
      periodDurationMs: 5 * 3600_000,
      ...(detailOnly ? { detailOnly: true } : {}),
    });
    const agy = state('antigravity-cli', [quota('Session', 20), quota('Session — Claude and GPT Models', 95, true)]);
    const overview = overviewView([agy], [], { ...OPTIONS, terminalWidth: 160 });
    const everything = overview.cards.flatMap((c) => c.lines.map(text)).join('\n') + overview.strip.map(text).join('\n');

    expect(everything).not.toContain('Claude and GPT');
    expect(everything).toContain('Session');
    expect(providerView(agy, [], WINDOWS[1]!, OPTIONS, 60).cards.flatMap((c) => c.lines.map(text)).join('\n')).toContain('Claude and GPT');
  });
});
