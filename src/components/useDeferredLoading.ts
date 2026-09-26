import { useEffect, useRef, useState } from 'react';

/** pr-stats' loading cadence: defer fast probes and hold visible feedback. */
export function useDeferredLoading(loading: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (loading && shownAt.current !== null) return;

    const delay = loading ? 300 : Math.max(0, (shownAt.current ?? 0) + 500 - Date.now());
    const timer = setTimeout(() => {
      shownAt.current = loading ? Date.now() : null;
      setVisible(loading);
    }, delay);

    return () => clearTimeout(timer);
  }, [loading]);

  return visible;
}
