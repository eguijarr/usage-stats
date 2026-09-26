import { useTerminalDimensions } from '@opentui/react';
import { theme } from '../theme';
import { ProviderIcon } from './ProviderIcon';
import { Spinner } from './Spinner';

export interface TabItem {
  label: string;
  icon?: string;
}

/**
 * Header row in the pr-stats layout: the app name with the data context
 * on the left and the spinner or the refresh status on the right.
 */
export function Header({
  context,
  spinning,
  paused,
  refreshedAt,
  intervalSec,
}: {
  context: string;
  spinning: boolean;
  paused: boolean;
  refreshedAt: number | null;
  intervalSec: number;
}) {
  const { width } = useTerminalDimensions();
  // same wording as pr-stats' status slot: "refreshed 10:16:35 AM · every 60s"
  const refreshed = refreshedAt === null ? '' : `refreshed ${new Date(refreshedAt).toLocaleTimeString()}`;
  const status = paused
    ? `${refreshed}${refreshed ? ' · ' : ''}paused · p resumes`
    : refreshedAt === null
      ? ''
      : `${refreshed} · every ${intervalSec}s`;

  const rightStatus = width < 40
    ? paused ? 'paused' : refreshedAt === null ? '' : new Date(refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : width < 90
    ? paused ? 'paused · p resumes' : refreshedAt === null ? '' : `refreshed ${new Date(refreshedAt).toLocaleTimeString()}`
    : status;

  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1} justifyContent="space-between" columnGap={3}>
      <text wrapMode="none" flexShrink={1}>
        <b fg={theme.accent}>usage-stats</b>
        {width >= 70 && <span fg={theme.muted}> · {context}</span>}
      </text>
      <box flexShrink={0} flexDirection="row" columnGap={1}>
        {spinning ? <Spinner /> : (
          <text wrapMode="none" fg={paused ? theme.warn : theme.muted}>
            {rightStatus}
          </text>
        )}
      </box>
    </box>
  );
}

/**
 * Tab bar with numbers, optional vendor icons, and tab labels.
 * Keeps the selected tab visible on narrow terminals.
 */
export function TabBar({
  tabs,
  active,
}: {
  tabs: (string | TabItem)[];
  active: number;
}) {
  const { width } = useTerminalDimensions();
  const available = Math.max(8, width - 6);

  const items: TabItem[] = tabs.map((t) => (typeof t === 'string' ? { label: t } : t));

  const itemWidths = items.map((tab, i) => {
    const numLen = String(i + 1).length + 2;
    const iconWidth = tab.icon ? 3 : 0;
    const labelLen = tab.label.length + 1;
    return numLen + iconWidth + labelLen;
  });

  let start = active;
  let end = active + 1;
  let used = itemWidths[active]!;

  while (start > 0 && used + itemWidths[start - 1]! + 1 <= available) {
    used += itemWidths[--start]! + 1;
  }
  while (end < items.length && used + itemWidths[end]! + 1 <= available) {
    used += itemWidths[end++]! + 1;
  }

  return (
    <box flexDirection="row" height={1} paddingLeft={1} marginTop={1} columnGap={1}>
      {start > 0 && <text fg={theme.dim}>‹</text>}
      {items.slice(start, end).map((tab, sliceIdx) => {
        const i = start + sliceIdx;
        const isActive = i === active;
        const bg = isActive ? theme.selectedBg : undefined;
        const fg = isActive ? theme.accent : theme.muted;

        const numPrefix = ` ${i + 1} `;
        const iconWidth = tab.icon ? 3 : 0;
        const prefixWidth = numPrefix.length + iconWidth;
        const maxLabelWidth = Math.max(2, available - prefixWidth - 1);

        const labelText =
          tab.label.length > maxLabelWidth
            ? `${tab.label.slice(0, Math.max(1, maxLabelWidth - 1))}… `
            : `${tab.label} `;

        return (
          <box key={i} flexDirection="row" backgroundColor={bg} flexShrink={0}>
            <text wrapMode="none" fg={fg} bg={bg} flexShrink={0}>
              {numPrefix}
            </text>
            {tab.icon && (
              <ProviderIcon
                id={tab.icon}
                bg={bg}
                fallbackFg={fg}
              />
            )}
            <text wrapMode="none" fg={fg} bg={bg} flexShrink={0}>
              {labelText}
            </text>
          </box>
        );
      })}
      {end < items.length && <text fg={theme.dim}>›</text>}
    </box>
  );
}

/**
 * Footer as in pr-stats: a full-width rule, one row of key hints, and a
 * blank row under it.
 */
export function Footer({ width, hints }: { width: number; hints: string[] }) {
  const quit = 'q quit';
  const shown: string[] = [];
  for (const hint of hints.filter((hint) => hint !== quit)) {
    if ([...shown, hint, quit].join(' · ').length <= width - 2) shown.push(hint);
  }
  shown.push(quit);
  return (
    <box flexDirection="column" height={3}>
      <text wrapMode="none" fg={theme.border}>
        {'─'.repeat(width)}
      </text>
      <box paddingLeft={1}>
        <text wrapMode="none" fg={theme.dim}>
          {shown.join(' · ')}
        </text>
      </box>
    </box>
  );
}
