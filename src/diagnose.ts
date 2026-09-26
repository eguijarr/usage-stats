import { CliRenderEvents, createCliRenderer, type TerminalCapabilities } from '@opentui/core';
import { spawnSync } from 'node:child_process';
import { chooseImageProtocol, tmuxClientFeatures } from './components/ProviderIcon';
import { publicText } from './privacy';

/**
 * Prints what the terminal reported about its graphics support and which
 * way the logos would render, for `usage-stats --diagnose`. The renderer
 * has to start for the terminal queries to run, so the screen flashes the
 * alternate buffer briefly before the report prints.
 */
export async function diagnose(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });

  const capabilities = await new Promise<TerminalCapabilities | null>((resolve) => {
    const timer = setTimeout(() => resolve(renderer.capabilities), 2500);

    renderer.once(CliRenderEvents.CAPABILITIES, () => {
      // resolution arrives with its own reply, give it a moment
      setTimeout(() => {
        clearTimeout(timer);
        resolve(renderer.capabilities);
      }, 500);
    });
  });
  const resolution = renderer.resolution;
  const protocol = chooseImageProtocol(capabilities, resolution !== null);

  renderer.destroy();

  const env = ['TERM', 'TERM_PROGRAM', 'COLORTERM', 'WT_SESSION', 'TMUX', 'WSL_DISTRO_NAME'];
  const tmux = process.env.TMUX ? spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout.trim() : null;

  const report = {
    environment: Object.fromEntries(env.map((key) => [key, process.env[key]
      ? (key === 'WT_SESSION' || key === 'TMUX' || key === 'WSL_DISTRO_NAME' ? 'set' : publicText(process.env[key]!)) : null])),
    terminal: capabilities?.terminal ? {
      name: publicText(capabilities.terminal.name), version: publicText(capabilities.terminal.version),
      from_xtversion: capabilities.terminal.from_xtversion,
    } : null,
    multiplexer: capabilities?.multiplexer ?? null,
    tmux: tmux === null ? null : publicText(tmux),
    tmuxClientFeatures: process.env.TMUX ? publicText(tmuxClientFeatures()) : null,
    kittyGraphics: capabilities?.kitty_graphics ?? null,
    sixel: capabilities?.sixel ?? null,
    pixelResolution: resolution,
    logos: protocol === null ? 'colored dot (no crisp image protocol available)' : `image via ${protocol}`,
  };

  console.log(JSON.stringify(report, null, 2));
}
