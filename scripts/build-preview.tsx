/** README preview from fictional fixtures only. Never probes a provider or loads history. */
import { Resvg } from '@resvg/resvg-js';
import { testRender } from '@opentui/react/test-utils';
import type { ScrollBoxRenderable } from '@opentui/core';
import { act, createRef } from 'react';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Header, TabBar, Footer } from '../src/components/Chrome';
import { Panel } from '../src/components/Panel';
import { setIconMode } from '../src/components/ProviderIcon';
import type { Sample } from '../src/history';
import { progress } from '../src/providers/types';
import { theme } from '../src/theme';
import { overviewView, providerView, WINDOWS, type ProviderState } from '../src/views';

process.env.TZ = 'UTC';
setIconMode('off');
const now = Date.parse('2030-01-01T12:00:00Z');
const hour = 3600_000;
const day = 24 * hour;
const quota = (label: string, used: number, period: number, left: number, dependsOn?: string[]) =>
  progress(label, used, 100, { periodDurationMs: period, resetsAt: new Date(now + left).toISOString(), dependsOn });
const state = (id: string, name: string, plan: string, lines: ReturnType<typeof progress>[]): ProviderState => ({
  id, snapshot: { providerId: id, displayName: name, plan, warning: null, lines },
  error: null, probing: false, lastOk: now, durationMs: 400, probeStartedAt: null,
});
const states = [
  state('claude', 'Claude', 'Pro', [quota('Session', 30, 5 * hour, 2 * hour, ['Weekly']), quota('Weekly', 45, 7 * day, 3 * day, ['Session'])]),
  state('codex', 'Codex', 'Plus', [quota('Session', 70, 5 * hour, hour, ['Weekly']), quota('Weekly', 20, 7 * day, 4 * day, ['Session'])]),
  state('cursor', 'Cursor', 'Pro', [quota('Cursor Models', 25, 30 * day, 12 * day, ['Total usage']),
    quota('Other Models', 18, 30 * day, 12 * day, ['Total usage']), quota('Total usage', 40, 30 * day, 12 * day),
    progress('Credits', 8, 20, { format: { kind: 'dollars' } })]),
  state('antigravity-cli', 'Antigravity CLI', 'Pro', [quota('Session', 20, 5 * hour, 3 * hour, ['Weekly']), quota('Weekly', 30, 7 * day, 5 * day, ['Session'])]),
  state('devin', 'Devin', 'Pro', [quota('Daily quota', 100, day, 8 * hour, ['Weekly quota']), quota('Weekly quota', 65, 7 * day, 2 * day, ['Daily quota'])]),
];
const history: Sample[] = states.flatMap((provider) => provider.snapshot!.lines.flatMap((line) =>
  line.type !== 'progress' ? [] : Array.from({ length: 25 }, (_, i) => ({
    p: provider.id, l: line.label, t: now - (24 - i) * hour, v: (line.used / line.limit) * (0.2 + 0.8 * i / 24),
  })),
));
const width = 100;
const height = 56;
const options = { now, staleAfterMs: 600_000, terminalWidth: width };
const overview = overviewView(states, history, options);
const views = [overview, { ...overview, cards: overview.cards.filter((card) => !card.full) },
  providerView(states[0]!, history, WINDOWS[1]!, options, 43)];
const cellWidth = 6;
const cellHeight = 12;
const gap = 16;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const rgb = (color: { toInts(): number[] }) => `rgb(${color.toInts().slice(0, 3).join(',')})`;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${3 * width * cellWidth + 2 * gap}" height="${height * cellHeight}">`;

for (const [index, view] of views.entries()) {
  const screenX = index * (width * cellWidth + gap);
  svg += `<rect x="${screenX}" y="0" width="${width * cellWidth}" height="${height * cellHeight}" fill="${theme.bg}"/>`;
  const scrollRef = createRef<ScrollBoxRenderable | null>();
  const setup = await testRender(
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      <Header context="DEMO · fictional data · UTC" spinning={false} paused={false} refreshedAt={now} intervalSec={60} />
      <TabBar tabs={[{ label: 'Overview' }, ...states.map((provider) => ({ label: provider.snapshot!.displayName, icon: provider.id }))]} active={index === 2 ? 1 : 0} />
      <box height={1} />
      <Panel scrollRef={scrollRef} view={view} />
      <Footer width={width} hints={['DEMO: fictional quotas', 'j/k scroll', '1-6 tabs', 'r refresh', 'q quit']} />
    </box>, { width, height },
  );
  await act(async () => { await setup.flush(); });
  const frame = setup.captureSpans();
  for (const [y, line] of frame.lines.entries()) {
    let x = index * (width * cellWidth + gap);
    for (const span of line.spans) {
      svg += `<rect x="${x}" y="${y * cellHeight}" width="${span.width * cellWidth}" height="${cellHeight}" fill="${rgb(span.bg)}"/>`;
      svg += `<text x="${x}" y="${y * cellHeight + 9}" font-family="IBM Plex Mono, DejaVu Sans Mono" font-size="10"${span.attributes & 1 ? ' font-weight="bold"' : ''} fill="${rgb(span.fg)}" xml:space="preserve">${escape(span.text)}</text>`;
      x += span.width * cellWidth;
    }
  }
  await act(async () => { setup.renderer.destroy(); });
}
svg += '</svg>';
const assets = join(import.meta.dir, '..', 'assets');
const fallbackFonts = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/Supplemental/Courier New.ttf',
  ...(process.env.WINDIR ? [join(process.env.WINDIR, 'Fonts', 'consola.ttf')] : []),
].filter(existsSync);
const image = new Resvg(svg, { font: {
  fontFiles: [join(assets, 'fonts', 'IBMPlexMono-Regular.ttf'), join(assets, 'fonts', 'IBMPlexMono-Bold.ttf'), ...fallbackFonts],
  loadSystemFonts: false, defaultFontFamily: 'IBM Plex Mono',
} }).render().asPng();
await Bun.write(join(assets, 'preview.png'), image);
console.log('assets/preview.png generated from fictional DEMO data.');
