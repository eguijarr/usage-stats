import { bold, fg, StyledText, TextRenderable, type TextChunk } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useRef } from 'react';
import { LineView } from './components/Panel';
import { repaintIcons } from './components/ProviderIcon';
import { usePolling } from './components/usePolling';
import { formatDuration } from './format';
import type { Sample } from './history';
import type { Line } from './model';
import type { ProviderSnapshot } from './providers/types';
import { theme } from './theme';
import { footerView, snapshotEvents } from './views';

/**
 * Rows the footer takes: the recommendation, one per provider, and the
 * key hints. The hints keep the logos off the terminal's last row, where
 * drawing a sixel image scrolls the whole screen.
 */
export function footerHeight(providers: number): number {
  return providers + 2;
}

function chunks(line: Line): TextChunk[] {
  return line.map((span) => {
    const chunk = fg(span.fg ?? theme.text)(span.text);
    return span.bold ? bold(chunk) : chunk;
  });
}

/**
 * A few live rows pinned under the terminal's own scrollback, in
 * OpenTUI's split-footer mode: the shell history stays above, and what
 * changes (resets, limits crossed, bursts, a new recommendation) is
 * written into it as a timestamped log, where it can be scrolled,
 * searched, and copied like any other output.
 */
export function FooterApp({
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
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();

  const log = useCallback((line: Line) => {
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const spans: Line = [{ text: `${stamp}  `, fg: theme.dim }, ...line];
    renderer.writeToScrollback((ctx) => {
      // one row per event, cut to the terminal like a log line
      let room = ctx.width;
      const fitted: Line = [];
      for (const span of spans) {
        if (room <= 0) break;
        fitted.push({ ...span, text: span.text.slice(0, room) });
        room -= span.text.length;
      }
      return {
        root: new TextRenderable(ctx.renderContext, { content: new StyledText(chunks(fitted)), width: ctx.width, height: 1, wrapMode: 'none' }),
        width: ctx.width,
        height: 1,
        startOnNewLine: true,
        trailingNewline: true,
      };
    });
    repaintIcons(renderer);
  }, [renderer]);

  const onSnapshot = useCallback((_id: string, previous: ProviderSnapshot | null, next: ProviderSnapshot) => {
    for (const event of snapshotEvents(next.displayName, previous, next)) log(event);
  }, [log]);

  const { states, history, now, refreshedAt, paused, togglePause, intervalSec, probeAll, profile } =
    usePolling({ providers, initialInterval, initialHistory, onSnapshot });

  const hints: Line = [
    { text: paused ? 'paused' : refreshedAt === null ? 'probing…' : `updated ${formatDuration(now - refreshedAt)} ago`, fg: paused ? theme.warn : theme.dim },
    { text: ` · r refresh · ${paused ? 'p resume' : 'p pause'} · q quit`, fg: theme.dim },
  ];
  const options = { now, staleAfterMs: Math.max(3 * intervalSec * 1000, 10 * 60_000), terminalWidth: width, profile };
  const view = footerView(states, history, options, Math.max(20, width - 2));

  // recommendations and bursts only mean something once every provider answered
  const ready = states.every((state) => state.snapshot !== null || state.error !== null);
  const lastFocus = useRef<string | null | undefined>(undefined);
  const lastFast = useRef(new Set<string>());

  useEffect(() => {
    log([
      { text: 'usage-stats', fg: theme.accent, bold: true },
      { text: ` · watching ${providers.length} ${providers.length === 1 ? 'provider' : 'providers'} · resets, limits, bursts and Use next changes are logged here`, fg: theme.muted },
    ]);
  }, [log, providers.length]);

  useEffect(() => {
    if (!ready) return;

    const focus = view.focus?.key ?? null;
    if (focus !== lastFocus.current) {
      if (view.focus !== null) log(view.focus.text);
      else if (lastFocus.current !== undefined) log([{ text: '◆ no clear priority any more', fg: theme.muted }]);
      lastFocus.current = focus;
    }

    const fast = new Set(view.fast.map((entry) => entry.key));
    for (const entry of view.fast) {
      if (!lastFast.current.has(entry.key)) log(entry.text);
    }
    lastFast.current = fast;
  });

  useKeyboard((key) => {
    if (key.name === 'q' || key.name === 'escape') {
      onQuit();
    } else if (key.name === 'r') {
      probeAll(key.shift);
    } else if (key.name === 'p') {
      togglePause();
    }
  });

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg} paddingLeft={1}>
      {view.lines.map((line, i) => <LineView key={i} line={line} />)}
      <LineView line={hints} />
    </box>
  );
}
