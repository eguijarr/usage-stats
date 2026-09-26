import { antigravity } from './antigravity';
import { claude } from './claude';
import { codex } from './codex';
import { cursor } from './cursor';
import { devin } from './devin';
import { ProviderError, type Provider, type ProviderSnapshot } from './types';
import { publicErrorMessage, publicSnapshot } from '../privacy';

export const PROVIDERS: Provider[] = [claude, codex, cursor, antigravity, devin];

export const DEFAULT_PROVIDERS = PROVIDERS.map((provider) => provider.id);

export interface ProbeResult {
  snapshot: ProviderSnapshot;
  durationMs: number;
  /**
   * Marks a result served from the last fetch because the provider's
   * minimum interval has not passed yet.
   */
  cached: boolean;
}

const last = new Map<string, { at: number; snapshot: ProviderSnapshot }>();

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Probes one provider and resolves its snapshot, or rejects with an Error
 * whose message is meant for the user.
 */
export async function probeProvider(id: string, force = false): Promise<ProbeResult> {
  const provider = providerById(id);

  if (provider === undefined) {
    throw new ProviderError(`Unknown provider. Known: ${DEFAULT_PROVIDERS.join(', ')}`);
  }

  const previous = last.get(id);

  if (!force && previous && provider.minIntervalMs && Date.now() - previous.at < provider.minIntervalMs) {
    return { snapshot: previous.snapshot, durationMs: 0, cached: true };
  }

  const started = Date.now();

  try {
    const result = await provider.probe();
    const snapshot = publicSnapshot({
      providerId: provider.id,
      displayName: provider.name,
      plan: result.plan,
      warning: result.warning ?? null,
      lines: result.lines,
    });

    last.set(id, { at: Date.now(), snapshot });

    return { snapshot, durationMs: Date.now() - started, cached: false };
  } catch (error) {
    throw new ProviderError(publicErrorMessage(error));
  }
}
