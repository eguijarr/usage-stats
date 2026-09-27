import {
  CliRenderEvents,
  resolveImageRenderProtocol,
  ScrollBoxRenderable,
  type BoxRenderable,
  type CliRenderer,
  type ImageRenderProtocol,
  type Renderable,
  type TerminalCapabilities,
} from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { useEffect, useRef, useState } from 'react';
import { decodePng, encodeSixel, type RgbaImage } from '../sixel';
import { brandColor } from '../views';

/**
 * How vendor logos render:
 * - auto: real images when the terminal draws Kitty or Sixel graphics
 *   (inside tmux too when it forwards sixel), the colored dot otherwise.
 *   The block-character fallback turns a two-cell logo into an unreadable
 *   smudge, so auto never uses it.
 * - always: an image whatever the protocol, blocks included.
 * - off: always the dot.
 */
export type IconMode = 'auto' | 'always' | 'off';

let mode: IconMode = 'auto';

export function setIconMode(next: IconMode): void {
  mode = next;
}

export function iconPath(id: string): string {
  return fileURLToPath(new URL(`../../assets/icons/${id}.png`, import.meta.url));
}

let tmuxFeaturesCache: string | null = null;

/**
 * Lists the features tmux knows the attached client terminal has, like
 * "256,RGB,sixel,...". tmux 3.4+ built with sixel support draws sixel
 * images itself and forwards them to a client that has the feature.
 */
export function tmuxClientFeatures(): string {
  if (tmuxFeaturesCache === null) {
    const result = spawnSync('tmux', ['display-message', '-p', '#{client_termfeatures}'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    tmuxFeaturesCache = result.status === 0 ? result.stdout.trim() : '';
  }

  return tmuxFeaturesCache;
}

/**
 * Terminals that answer the Kitty graphics query with OK but never draw
 * the images, which would leave blank cells where the dot belongs. Apps
 * embedding libghostty report that name and may not render images, while
 * Ghostty itself reports "ghostty" and draws them fine.
 */
const ACKS_WITHOUT_DRAWING = new Set(['libghostty']);

/**
 * Picks how logos render, or null for the colored dot. Kitty goes through
 * OpenTUI's image component. Sixel is drawn by this module instead (see
 * the overlay below), because OpenTUI only uses sixel when the terminal
 * reports its pixel size, which Windows Terminal may not, and because
 * OpenTUI's redraws erase sixel images it does not always put back.
 */
export function chooseImageProtocol(
  capabilities: TerminalCapabilities | null,
  hasResolution: boolean,
): ImageRenderProtocol | null {
  if (mode === 'off') {
    return null;
  }

  if (capabilities?.multiplexer === 'tmux' || process.env.TMUX) {
    if (tmuxClientFeatures().split(',').includes('sixel')) {
      return 'sixel';
    }

    return mode === 'always' ? 'blocks' : null;
  }

  if (capabilities?.sixel) {
    return 'sixel';
  }

  const protocol = resolveImageRenderProtocol('auto', capabilities, hasResolution);

  if (protocol === 'kitty' && ACKS_WITHOUT_DRAWING.has(capabilities?.terminal.name ?? '')) {
    return mode === 'always' ? protocol : null;
  }

  if (protocol === 'kitty') {
    return protocol;
  }

  return mode === 'always' ? protocol : null;
}

/**
 * Tracks the protocol for logos. Capabilities and the pixel size arrive
 * asynchronously after startup, so the choice is re-read when they do.
 */
function useImageProtocol(): ImageRenderProtocol | null {
  const renderer = useRenderer();
  const read = () => chooseImageProtocol(renderer.capabilities, renderer.resolution !== null);
  const [protocol, setProtocol] = useState(read);

  useEffect(() => {
    const update = () => setProtocol(read());

    renderer.on(CliRenderEvents.CAPABILITIES, update);
    renderer.on(CliRenderEvents.RESIZE, update);
    update();

    return () => {
      renderer.off(CliRenderEvents.CAPABILITIES, update);
      renderer.off(CliRenderEvents.RESIZE, update);
    };
    // read only closes over the renderer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer]);

  return protocol;
}

// --- sixel overlay ---------------------------------------------------------

/**
 * Sixel pixels per cell when the terminal does not report its size. It is
 * the VT340 convention that Windows Terminal scales sixel images to.
 */
const DEFAULT_CELL = { width: 10, height: 20 };

const slots = new Map<number, { renderable: Renderable; id: string; bg?: string }>();
let nextSlot = 0;
let overlayRenderer: CliRenderer | null = null;
let lastSignature = '';
let repaintPending = false;
const decoded = new Map<string, RgbaImage | null>();
const encoded = new Map<string, string>();

export function cellSize(renderer: CliRenderer): { width: number; height: number } {
  const resolution = renderer.resolution;
  const width = renderer.terminalWidth || renderer.width;
  const height = renderer.terminalHeight || renderer.height;

  if (resolution && width > 0 && height > 0) {
    return {
      width: Math.max(1, Math.floor(resolution.width / width)),
      height: Math.max(1, Math.floor(resolution.height / height)),
    };
  }

  return DEFAULT_CELL;
}

function sixelFor(id: string, width: number, height: number, bg?: string): string | null {
  const key = `${id}:${width}x${height}:${bg ?? ''}`;
  const cached = encoded.get(key);

  if (cached !== undefined) {
    return cached;
  }

  if (!decoded.has(id)) {
    try {
      decoded.set(id, decodePng(readFileSync(iconPath(id))));
    } catch {
      decoded.set(id, null);
    }
  }

  const image = decoded.get(id);

  if (!image) {
    return null;
  }

  const sixel = encodeSixel(image, width, height, brandColor(id), bg);
  encoded.set(key, sixel);

  return sixel;
}

/**
 * Reports whether a renderable is on screen, which for content inside a
 * scroll box means inside its viewport.
 */
function onScreen(renderable: Renderable, rows: number): boolean {
  const y = renderable.screenY;

  if (!renderable.visible || y < 0 || y >= rows) {
    return false;
  }

  for (let parent = renderable.parent; parent; parent = parent.parent) {
    if (parent instanceof ScrollBoxRenderable) {
      const viewport = parent.viewport;

      if (y < viewport.screenY || y >= viewport.screenY + viewport.height) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Paints the sixel logos over the frame OpenTUI just wrote. OpenTUI sees
 * the logo cells as blank, so its later frames leave them alone, except
 * when a row is rewritten, which erases the image; redrawing after every
 * frame puts it back. When the logos move, a full repaint first wipes the
 * old images so no stale logo lingers where the layout left blank cells.
 */
function drawSixels(renderer: CliRenderer): void {
  const cell = cellSize(renderer);
  // the footer mode draws its frame below the scrollback, from this terminal row on
  const offset = (renderer as unknown as { renderOffset?: number }).renderOffset ?? 0;
  const termHeight = renderer.terminalHeight || renderer.height;
  const visible = [...slots.values()].filter(
    (slot) => onScreen(slot.renderable, renderer.height) && offset + slot.renderable.screenY < termHeight - 1,
  );
  const signature = `${offset}:` + visible.map((slot) => `${slot.id}@${slot.renderable.screenX},${slot.renderable.screenY}@${slot.bg ?? ''}`).join('|');

  if (signature !== lastSignature && lastSignature !== '' && !repaintPending) {
    repaintPending = true;
    (renderer as unknown as { forceFullRepaintRequested: boolean }).forceFullRepaintRequested = true;
    renderer.requestRender();
    return;
  }

  repaintPending = false;
  lastSignature = signature;

  if (visible.length === 0) {
    return;
  }

  let out = '\x1b7';

  for (const slot of visible) {
    const sixel = sixelFor(slot.id, cell.width * 2, cell.height, slot.bg);

    if (sixel !== null) {
      out += `\x1b[${offset + slot.renderable.screenY + 1};${slot.renderable.screenX + 1}H${sixel}`;
    }
  }

  out += '\x1b8';

  // through OpenTUI's own writer, so the bytes stay ordered with its frames
  const writer = renderer as unknown as { writeOut?: (data: string) => void };

  if (typeof writer.writeOut === 'function') {
    writer.writeOut(out);
  } else {
    process.stdout.write(out);
  }
}

/**
 * Rewrites every cell of the frame and puts the logos back. The footer
 * mode needs it after each line it logs: the terminal scrolls the logos
 * drawn so far along with the text, off the cells OpenTUI keeps blank.
 */
export function repaintIcons(renderer: CliRenderer): void {
  (renderer as unknown as { forceFullRepaintRequested: boolean }).forceFullRepaintRequested = true;
  renderer.requestRender();
}

function installOverlay(renderer: CliRenderer): void {
  if (overlayRenderer === renderer) {
    return;
  }

  overlayRenderer = renderer;
  renderer.on(CliRenderEvents.FRAME, () => drawSixels(renderer));
}

/**
 * Blank two-cell slot the overlay paints a sixel logo into.
 */
function SixelSlot({ id, bg }: { id: string; bg?: string }) {
  const renderer = useRenderer();
  const ref = useRef<BoxRenderable | null>(null);

  useEffect(() => {
    installOverlay(renderer);

    const renderable = ref.current;

    if (renderable === null) {
      return undefined;
    }

    const key = nextSlot++;
    slots.set(key, { renderable, id, bg });
    renderer.requestRender();

    return () => {
      slots.delete(key);
      renderer.requestRender();
    };
  }, [renderer, id, bg]);

  return <box ref={ref} width={3} height={1} backgroundColor={bg} flexShrink={0} />;
}

/**
 * A provider's logo, two cells wide and one tall, or its brand-colored dot
 * when the terminal cannot show the logo crisply. Both reserve three cells,
 * so the text after them lines up the same either way.
 */
export function ProviderIcon({
  id,
  bg,
  fallbackText,
  fallbackFg,
}: {
  id: string;
  bg?: string;
  fallbackText?: string;
  fallbackFg?: string;
}) {
  const protocol = useImageProtocol();
  const path = iconPath(id);

  if (protocol !== null && existsSync(path)) {
    if (protocol === 'sixel') {
      return <SixelSlot id={id} bg={bg} />;
    }

    return (
      <box width={3} height={1} backgroundColor={bg} flexShrink={0}>
        <image source={path} width={2} height={1} fit="fit" protocol={protocol} />
      </box>
    );
  }

  return (
    <text wrapMode="none" fg={fallbackFg ?? brandColor(id)} bg={bg} flexShrink={0}>
      {fallbackText === undefined ? '●  ' : fallbackText.padEnd(3, ' ')}
    </text>
  );
}
