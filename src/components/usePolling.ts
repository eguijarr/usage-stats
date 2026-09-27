import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { recordSnapshot, type Sample } from '../history';
import { activityProfile } from '../pace';
import { publicErrorMessage } from '../privacy';
import { probeProvider } from '../providers';
import type { ProviderSnapshot } from '../providers/types';
import type { ProviderState } from '../views';

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 600;

/**
 * The activity profile reads the whole history, and the hours it learns
 * do not move from one poll to the next.
 */
const PROFILE_REFRESH_MS = 10 * 60_000;

/**
 * Polls the providers on the chosen interval and keeps their states, the
 * history, a one-second clock, and the learned activity profile. Both the
 * full-screen app and the footer mode run on it.
 */
export function usePolling({
  providers,
  initialInterval,
  initialHistory,
  onSnapshot,
}: {
  providers: string[];
  initialInterval: number;
  initialHistory: Sample[];
  /** Hears each fresh snapshot with the one it replaces, for the footer's event log. */
  onSnapshot?: (id: string, previous: ProviderSnapshot | null, next: ProviderSnapshot) => void;
}) {
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
  const [intervalSec, setIntervalSec] = useState(initialInterval);
  const [now, setNow] = useState(() => Date.now());
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const nextAt = useRef(Date.now());
  const inFlight = useRef(new Set<string>());
  const intervalRef = useRef(intervalSec);
  intervalRef.current = intervalSec;
  const historyRef = useRef(history);
  historyRef.current = history;
  const snapshots = useRef(new Map<string, ProviderSnapshot>());
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

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

              onSnapshotRef.current?.(id, snapshots.current.get(id) ?? null, result.snapshot);
              snapshots.current.set(id, result.snapshot);
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

  const changeInterval = useCallback((delta: number) => {
    // reads the ref, since two presses can land before a re-render refreshes the state
    const next = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, intervalRef.current + delta));
    intervalRef.current = next;
    setIntervalSec(next);
    nextAt.current = Date.now() + next * 1000;
  }, []);

  const togglePause = useCallback(() => {
    setPaused((current) => {
      // resuming refreshes at once, the data may be minutes old by then
      if (current) {
        probeAll();
      }
      return !current;
    });
  }, [probeAll]);

  const profileTick = Math.floor(now / PROFILE_REFRESH_MS);
  const profile = useMemo(() => activityProfile(historyRef.current), [profileTick]);

  return { states, history, now, refreshedAt, paused, togglePause, intervalSec, changeInterval, probeAll, profile };
}
