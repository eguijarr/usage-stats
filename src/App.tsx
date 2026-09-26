import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Footer, Header, TabBar, type TabItem } from './components/Chrome';
import { Panel } from './components/Panel';
import { useDeferredLoading } from './components/useDeferredLoading';
import { theme } from './theme';
import { publicErrorMessage } from './privacy';
import { recordSnapshot, type Sample } from './history';
import { probeProvider } from './providers';
import { displayName, overviewView, providerView, WINDOWS, type ProviderState } from './views';

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 600;
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

  const [states, setStates] = useState<ProviderState[]>(() =>
    providers.map((id) => ({
      id,
      snapshot: null,
      error: null,
      probing: false,
      lastOk: null,
      durationMs: null,
      probeStartedAt: null,
    })),
  );
  const [history, setHistory] = useState<Sample[]>(initialHistory);
  const [tab, setTab] = useState(0);
  const [intervalSec, setIntervalSec] = useState(initialInterval);
  const [windowIndex, setWindowIndex] = useState(1);
  const [now, setNow] = useState(() => Date.now());
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const nextAt = useRef(Date.now());
  const inFlight = useRef(new Set<string>());
  const intervalRef = useRef(intervalSec);
  intervalRef.current = intervalSec;

  const patch = useCallback((id: string, update: (state: ProviderState) => Partial<ProviderState>) => {
    setStates((previous) => previous.map((state) => (state.id === id ? { ...state, ...update(state) } : state)));
  }, []);

  /**
   * Starts a probe for every provider that has none running. Each result
   * lands on its own, so fast providers refresh without waiting for slow
   * ones, and a failed probe keeps the last good data on screen.
   */
  const probeAll = useCallback(
    (force = false) => {
      nextAt.current = Date.now() + intervalRef.current * 1000;

      for (const id of providers) {
        if (inFlight.current.has(id)) {
          continue;
        }

        inFlight.current.add(id);
        patch(id, () => ({ probing: true, probeStartedAt: Date.now() }));

        probeProvider(id, force)
          .then((result) => {
            const at = Date.now();

            if (!result.cached) {
              const samples = recordSnapshot(result.snapshot, at);

              if (samples.length > 0) {
                setHistory((previous) => [...previous, ...samples]);
              }
            }

            patch(id, (state) => ({
              snapshot: result.snapshot,
              error: null,
              lastOk: result.cached ? state.lastOk : at,
              durationMs: result.cached ? state.durationMs : result.durationMs,
            }));
            setRefreshedAt(at);
          })
          .catch((error: unknown) => {
            patch(id, () => ({ error: publicErrorMessage(error) }));
          })
          .finally(() => {
            inFlight.current.delete(id);
            patch(id, () => ({ probing: false, probeStartedAt: null }));
          });
      }
    },
    [providers, patch],
  );

  useEffect(() => {
    probeAll();

    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);

      if (!pausedRef.current && current >= nextAt.current) {
        probeAll();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [probeAll]);

  const tabs: TabItem[] = [
    { label: 'Overview' },
    ...states.map((s) => ({ label: displayName(s), icon: s.id })),
  ];
  const window = WINDOWS[windowIndex]!;
  const chartWidth = Math.max(40, Math.min(90, Math.floor((width - 8) / 2)));
  // three missed cycles, or ten minutes for Claude's slower cadence, before data counts as stale
  const viewOptions = { now, staleAfterMs: Math.max(3 * intervalSec * 1000, 10 * 60_000), terminalWidth: width };
  const view =
    tab === 0
      ? overviewView(states, history, viewOptions)
      : providerView(states[tab - 1]!, history, window, viewOptions, chartWidth);

  const spinning = useDeferredLoading(states.some((state) => state.probing));

  const changeInterval = (delta: number) => {
    // reads the ref, since two presses can land before a re-render refreshes the state
    const next = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, intervalRef.current + delta));
    intervalRef.current = next;
    setIntervalSec(next);
    nextAt.current = Date.now() + next * 1000;
  };

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
      setPaused((current) => {
        // resuming refreshes at once, the data may be minutes old by then
        if (current) {
          probeAll();
        }
        return !current;
      });
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
