import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { parseArgs } from 'node:util';
import { App } from './App';
import { FooterApp, footerHeight } from './FooterApp';
import { setIconMode, type IconMode } from './components/ProviderIcon';
import { loadHistory } from './history';
import { publicErrorMessage } from './privacy';
import { DEFAULT_PROVIDERS, probeProvider, providerById } from './providers';

const HELP = `usage-stats — live AI subscription usage in a pr-stats style terminal UI

Usage: usage-stats [options]

Windows Terminal (WSL launcher):
      --wt-tab              Open a full-width tab with the usage-stats font/profile
      --wt                  Open a pane next to the current one

Options:
  -i, --interval <sec>      Seconds between probes (default 60, min 15)
  -p, --providers <ids>     Comma-separated providers
                            (default ${DEFAULT_PROVIDERS.join(',')})
      --icons <mode>        Vendor logos: auto (Kitty/Sixel terminals), always, off
                            (default auto; the colored dot is the fallback)
      --footer              Pin a few live rows under the shell's scrollback
                            and log resets, limits and bursts into it
      --json                Probe once, print JSON to stdout, and exit
      --diagnose            Report the terminal's graphics support and exit
  -h, --help                Show this help

Environment:
  USAGE_STATS_INTERVAL, USAGE_STATS_PROVIDERS   defaults for the flags above
  USAGE_STATS_HISTORY_DAYS   Days of local history to keep (default 62, 7-400)
  USAGE_STATS_WINDOWS_HOME   Windows profile to search from WSL (auto-detected)
  CLAUDE_CONFIG_DIR, CODEX_HOME, CURSOR_STATE_DB   credential location overrides

Keys: 1-9 tabs · ←/→ switch · j/k scroll · r refresh · R force refresh · +/- interval · w trend window · q quit`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      interval: { type: 'string', short: 'i' },
      providers: { type: 'string', short: 'p' },
      json: { type: 'boolean' },
      footer: { type: 'boolean' },
      icons: { type: 'string' },
      diagnose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const interval = Math.max(15, Number.parseInt(values.interval ?? process.env.USAGE_STATS_INTERVAL ?? '60', 10) || 60);
  const providers = (values.providers ?? process.env.USAGE_STATS_PROVIDERS ?? DEFAULT_PROVIDERS.join(','))
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const icons = (values.icons ?? process.env.USAGE_STATS_ICONS ?? 'auto') as IconMode;

  if (!['auto', 'always', 'off'].includes(icons)) {
    console.error('--icons must be auto, always, or off.');
    process.exit(1);
  }

  setIconMode(icons);

  if (values.diagnose) {
    const { diagnose } = await import('./diagnose');
    await diagnose();
    process.exit(0);
  }

  const unknown = providers.filter((id) => providerById(id) === undefined);

  if (unknown.length > 0) {
    console.error(`Unknown provider(s). Known: ${DEFAULT_PROVIDERS.join(', ')}`);
    process.exit(1);
  }

  /**
   * The --json flag skips the TUI and prints one probe of every provider,
   * which is handy for scripts and for checking a login without the UI.
   */
  if (values.json) {
    const results = await Promise.all(
      providers.map((id) =>
        probeProvider(id).then(
          (result) => ({ ...result.snapshot, error: null }),
          (error: unknown) => ({ providerId: id, error: publicErrorMessage(error) }),
        ),
      ),
    );
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  const history = loadHistory();

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    exitSignals: ['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGABRT', 'SIGHUP'],
    // the footer leaves the mouse wheel to the terminal, to scroll the log above it
    ...(values.footer ? { screenMode: 'split-footer' as const, footerHeight: footerHeight(providers.length), useMouse: false } : {}),
  });

  const quit = () => {
    renderer.destroy();
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, quit);
  }

  if (values.footer) {
    createRoot(renderer).render(
      <FooterApp providers={providers} initialInterval={interval} initialHistory={history} onQuit={quit} />,
    );
    return;
  }

  createRoot(renderer).render(
    <App providers={providers} initialInterval={interval} initialHistory={history} onQuit={quit} />,
  );
}

main().catch((error: unknown) => {
  console.error(publicErrorMessage(error));
  process.exit(1);
});
