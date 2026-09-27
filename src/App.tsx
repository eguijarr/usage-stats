import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useRef, useState } from 'react';
import { Footer, Header, TabBar, type TabItem } from './components/Chrome';
import { Panel } from './components/Panel';
import { useDeferredLoading } from './components/useDeferredLoading';
import { usePolling } from './components/usePolling';
import { theme } from './theme';
import type { Sample } from './history';
import { displayName, overviewView, providerView, WINDOWS } from './views';

const INTERVAL_STEP = 15;

export function App({
  providers,
  initialInterval,
  initialHistory,
  onQuit,
}: {
  providers: string[];
  initialInterval: number;
  initialHistory: Sample[];
  onQuit: () => void;
}) {
  const { width } = useTerminalDimensions();
  const renderer = useRenderer();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  const { states, history, now, refreshedAt, paused, togglePause, intervalSec, changeInterval, probeAll, profile } =
    usePolling({ providers, initialInterval, initialHistory });
  const [tab, setTab] = useState(0);
  const [windowIndex, setWindowIndex] = useState(1);

  const tabs: TabItem[] = [
    { label: 'Overview' },
    ...states.map((s) => ({ label: displayName(s), icon: s.id })),
  ];
  const window = WINDOWS[windowIndex]!;
  const chartWidth = Math.max(40, Math.min(90, Math.floor((width - 8) / 2)));
  // three missed cycles, or ten minutes for Claude's slower cadence, before data counts as stale
  const viewOptions = { now, staleAfterMs: Math.max(3 * intervalSec * 1000, 10 * 60_000), terminalWidth: width, profile };
  const view =
    tab === 0
      ? overviewView(states, history, viewOptions)
      : providerView(states[tab - 1]!, history, window, viewOptions, chartWidth);

  const spinning = useDeferredLoading(states.some((state) => state.probing));

  useKeyboard((key) => {
    const name = key.name;
    const seq = key.sequence;

    if (name === 'q') {
      onQuit();
    } else if (key.ctrl && name === 'l') {
      // redraw everything, logos included, e.g. after reattaching with dtach
      renderer.suspend();
      renderer.resume();
    } else if (/^[1-9]$/.test(name) && Number(name) <= tabs.length) {
      setTab(Number(name) - 1);
    } else if (name === 'right' || name === 'l' || (name === 'tab' && !key.shift)) {
      setTab((current) => (current + 1) % tabs.length);
    } else if (name === 'left' || name === 'h' || (name === 'tab' && key.shift)) {
      setTab((current) => (current - 1 + tabs.length) % tabs.length);
    } else if (name === 'escape') {
      setTab(0);
    } else if (name === 'j' || name === 'down') {
      scrollRef.current?.scrollBy(2);
    } else if (name === 'k' || name === 'up') {
      scrollRef.current?.scrollBy(-2);
    } else if (name === 'pagedown' || name === 'space') {
      scrollRef.current?.scrollBy(10);
    } else if (name === 'pageup') {
      scrollRef.current?.scrollBy(-10);
    } else if (name === 'r') {
      probeAll(key.shift);
    } else if (seq === '+' || seq === '=') {
      changeInterval(INTERVAL_STEP);
    } else if (seq === '-' || seq === '_') {
      changeInterval(-INTERVAL_STEP);
    } else if (name === 'p') {
      togglePause();
    } else if (name === 'w') {
      setWindowIndex((current) => (current + 1) % WINDOWS.length);
    }
  });

  const context = [
    `${providers.length} ${providers.length === 1 ? 'provider' : 'providers'}`,
    `trend ${window.label}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ].join(' · ');

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      <Header
        context={context}
        spinning={spinning}
        paused={paused}
        refreshedAt={refreshedAt}
        intervalSec={intervalSec}
      />
      <TabBar tabs={tabs} active={tab} />
      <box height={1} />
      <Panel key={tab} scrollRef={scrollRef} view={view} />
      <Footer
        width={width}
        hints={[
          'esc back',
          'j/k scroll',
          `1-${tabs.length} tabs`,
          '←/→ switch',
          'r refresh (R force)',
          paused ? 'p resume' : 'p pause',
          `+/- interval ${intervalSec}s`,
          `w window ${window.label}`,
          'q quit',
        ]}
      />
    </box>
  );
}
