import type { ScrollBoxRenderable } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import type { RefObject } from 'react';
import type { Card, Line, Span } from '../model';
import { lineWidth } from '../model';
import { theme } from '../theme';
import type { View } from '../views';
import { ProviderIcon } from './ProviderIcon';
import { overlayScrollbar, useScrollbarSettle } from './scrollbar';

const COLUMN_GAP = 4;

/**
 * Stats panel modeled on pr-stats' ChartsPanel: a pinned summary strip and
 * scope row framed by rules, then the cards in a scroll area, dealt into
 * two columns when they fit side by side.
 */
export function Panel({ scrollRef, view }: { scrollRef: RefObject<ScrollBoxRenderable | null>; view: View }) {
  useScrollbarSettle(scrollRef, view.empty === null);

  const { width } = useTerminalDimensions();
  const contentWidth = Math.max(1, width - 4);
  const stripRows: Line[][] = [];
  let rowWidth = 0;
  for (const line of view.strip.filter((line) => line.length > 0)) {
    const needed = lineWidth(line);
    if (stripRows.length === 0 || rowWidth + 2 + needed > contentWidth) {
      stripRows.push([line]);
      rowWidth = needed;
    } else {
      stripRows.at(-1)!.push(line);
      rowWidth += needed + 2;
    }
  }
  const inlineHeading = (view.heading?.length ?? 0) + (view.headingIcon ? 3 : 0) + 4 + lineWidth(view.headline ?? []) <= contentWidth;

  /**
   * Full-width cards break the flow into segments, and the cards between
   * them share one grid, so a wide card never forces its neighbors into a
   * single column.
   */
  const segments: Card[][] = [];

  for (const c of view.cards) {
    const last = segments.at(-1);

    if (c.full || last === undefined || last[0]!.full) {
      segments.push([c]);
    } else {
      last.push(c);
    }
  }

  const cards = (
    <box flexDirection="column" rowGap={1}>
      {segments.map((segment) =>
        segment[0]!.full ? (
          <CardView key={segment[0]!.title} card={segment[0]!} width={contentWidth} />
        ) : (
          <Grid key={segment[0]!.title} cards={segment} width={width} />
        ),
      )}
    </box>
  );

  return (
    <box flexGrow={1} flexDirection="column">
      <Rule width={width} />

      <box paddingLeft={1} paddingRight={2} flexDirection="column" flexShrink={0}>
        {stripRows.map((row, i) => (
          <box key={i} flexDirection="row" justifyContent="space-between" columnGap={2}>
            {row.map((line, j) => <LineView key={j} line={line} wrap />)}
          </box>
        ))}
      </box>

      {(view.heading !== null || view.headline !== null) && (
        <box paddingLeft={1} paddingRight={2} flexShrink={0}
          flexDirection={inlineHeading ? 'row' : 'column'} justifyContent="space-between">
          {view.heading !== null && (
            <box flexDirection="row" flexShrink={0} alignItems="center">
              <text wrapMode="none" flexShrink={0}>
                <span fg={theme.accent}>▸ </span>
              </text>
              {view.headingIcon && <ProviderIcon id={view.headingIcon} />}
              <text wrapMode="none" flexShrink={0}>
                <b fg={theme.text}>{view.heading}</b>
              </text>
            </box>
          )}
          {view.headline !== null && <LineView line={view.headline} wrap={!inlineHeading} />}
        </box>
      )}

      <Rule width={width} />

      {view.empty !== null ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.muted}>{view.empty}</text>
        </box>
      ) : (
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          paddingLeft={1}
          paddingRight={2}
          verticalScrollbarOptions={overlayScrollbar}
        >
          <box marginTop={1} marginBottom={1}>
            {cards}
          </box>
        </scrollbox>
      )}
    </box>
  );
}

/**
 * Deals the cards into two columns row by row when they fit side by side,
 * so each pair top aligns, and stacks them otherwise.
 */
function Grid({ cards, width }: { cards: Card[]; width: number }) {
  const left = cards.filter((_, i) => i % 2 === 0);
  const right = cards.filter((_, i) => i % 2 === 1);
  // Long subtitles can use a second line instead of collapsing the grid.
  const minimumWidth = (c: Card) => Math.max(c.title.length + (c.icon ? 3 : 0), ...c.lines.map(lineWidth));
  const leftMin = Math.max(0, ...left.map(minimumWidth));
  const rightMin = Math.max(0, ...right.map(minimumWidth));
  const available = Math.max(1, width - 4);
  const twoColumns = right.length > 0 && available >= leftMin + COLUMN_GAP + rightMin;
  const extra = Math.max(0, available - leftMin - rightMin - COLUMN_GAP);
  const leftWidth = leftMin + Math.floor(extra / 2);
  const rightWidth = rightMin + Math.ceil(extra / 2);

  if (!twoColumns) {
    return (
      <box flexDirection="column" rowGap={1}>
        {cards.map((c) => (
          <CardView key={c.title} card={c} width={available} />
        ))}
      </box>
    );
  }

  return (
    <box flexDirection="column" rowGap={1}>
      {left.map((leftCard, i) => (
        <box key={leftCard.title} flexDirection="row" alignItems="flex-start" columnGap={COLUMN_GAP}>
          <box flexDirection="column" width={leftWidth} flexShrink={0}>
            <CardView card={leftCard} width={leftWidth} />
          </box>
          <box flexDirection="column" width={rightWidth} flexShrink={0}>
            {right[i] !== undefined && <CardView card={right[i]} width={rightWidth} />}
          </box>
        </box>
      ))}
    </box>
  );
}

function Rule({ width }: { width: number }) {
  return (
    <box height={1}>
      <text wrapMode="none" fg={theme.border}>
        {'─'.repeat(width)}
      </text>
    </box>
  );
}

function SpanView({ span }: { span: Span }) {
  return span.bold === true ? (
    <b fg={span.fg ?? theme.text} bg={span.bg}>
      {span.text}
    </b>
  ) : (
    <span fg={span.fg ?? theme.text} bg={span.bg}>
      {span.text}
    </span>
  );
}

export function LineView({ line, wrap = false }: { line: Line; wrap?: boolean }) {
  const iconIdx = line.findIndex((span) => span.icon !== undefined);
  if (iconIdx === -1) {
    return (
      <text wrapMode={wrap ? 'word' : 'none'} flexShrink={1}>
        {line.map((span, i) => (
          <SpanView key={i} span={span} />
        ))}
      </text>
    );
  }

  const iconSpan = line[iconIdx]!;
  const before = line.slice(0, iconIdx);
  const after = line.slice(iconIdx + 1);

  return (
    <box flexDirection="row" backgroundColor={iconSpan.bg} flexShrink={1}>
      {before.length > 0 && (
        <text wrapMode="none" flexShrink={0}>
          {before.map((span, i) => (
            <SpanView key={i} span={span} />
          ))}
        </text>
      )}
      <ProviderIcon
        id={iconSpan.icon!}
        bg={iconSpan.bg}
        fallbackText={iconSpan.text ? (iconSpan.text.endsWith(' ') ? iconSpan.text : `${iconSpan.text} `) : '● '}
        fallbackFg={iconSpan.fg}
      />
      {after.length > 0 && (
        <text wrapMode={wrap ? 'word' : 'none'} flexShrink={1}>
          {after.map((span, i) => (
            <SpanView key={i} span={span} />
          ))}
        </text>
      )}
    </box>
  );
}

function CardView({ card, width }: { card: Card; width: number }) {
  const titleWidth = card.title.length + (card.icon !== null ? 3 : card.mark !== null ? card.mark.text.length + 1 : 0);
  const inlineSubtitle = titleWidth + 2 + lineWidth(card.subtitle) <= width;
  const subtitle = card.subtitle.map((span, i) => (
    <span key={i} fg={span.fg ?? theme.muted} bg={span.bg}>{span.text}</span>
  ));
  return (
    <box flexDirection="column" width={width}>
      <box flexDirection="row" height={1} justifyContent={card.full ? 'space-between' : undefined}>
        <box flexDirection="row" flexShrink={1}>
          {card.icon !== null && <ProviderIcon id={card.icon} />}
          <text wrapMode="none" flexShrink={1}>
            {card.icon === null && card.mark !== null && <span fg={card.mark.fg ?? theme.text}>{`${card.mark.text} `}</span>}
            <b fg={theme.text}>{card.title}</b>
            {inlineSubtitle && !card.full && <><span>{'  '}</span>{subtitle}</>}
          </text>
        </box>
        {inlineSubtitle && card.full && <text wrapMode="none" flexShrink={0}>{subtitle}</text>}
      </box>
      {!inlineSubtitle && <text wrapMode="word">{subtitle}</text>}
      <box flexDirection="column" marginTop={1}>
        {card.lines.map((line, i) => (
          <LineView key={i} line={line} wrap={lineWidth(line) > width} />
        ))}
      </box>
    </box>
  );
}
