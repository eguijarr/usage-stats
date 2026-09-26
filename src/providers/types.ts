/**
 * Metric lines a provider reports. The shapes follow the OpenUsage plugin
 * line model, so progress quotas, text facts, badges, and bar charts all
 * render through the same views.
 */
export type ProgressFormat = { kind: 'percent' } | { kind: 'dollars' } | { kind: 'count'; suffix?: string };

export interface ProgressLine {
  type: 'progress';
  label: string;
  used: number;
  limit: number;
  format: ProgressFormat;
  resetsAt: string | null;
  periodDurationMs: number | null;
  /** Other reported quotas that constrain this quota, identified by label. */
  dependsOn?: string[];
  /**
   * Marks an allowance outside the provider's coding quotas, like Cursor's
   * Grok bot. It shows on the provider's card but stays out of planning
   * across providers, such as Upcoming resets, where it is not comparable.
   */
  auxiliary?: boolean;
  /**
   * Shows the quota only on its provider's own tab, never in the overview,
   * for quotas not worth weighing against the rest, like Antigravity's
   * allowance for older Claude and GPT models.
   */
  detailOnly?: boolean;
}

export interface TextLine {
  type: 'text';
  label: string;
  value: string;
  subtitle?: string | null;
}

export interface BadgeLine {
  type: 'badge';
  label: string;
  text: string;
}

export interface BarChartLine {
  type: 'barChart';
  label: string;
  points: { label: string; value: number; valueLabel?: string | null }[];
  note?: string | null;
}

export type MetricLine = ProgressLine | TextLine | BadgeLine | BarChartLine;

export interface ProviderSnapshot {
  providerId: string;
  displayName: string;
  plan: string | null;
  warning: string | null;
  lines: MetricLine[];
}

export interface ProviderResult {
  plan: string | null;
  lines: MetricLine[];
  warning?: string | null;
}

export interface Provider {
  id: string;
  name: string;
  /**
   * Lower bound between two live fetches. A probe that comes sooner gets
   * the previous result back, which keeps rate-limited APIs happy while
   * the UI refreshes faster.
   */
  minIntervalMs?: number;
  probe(): Promise<ProviderResult>;
}

/**
 * Error with a message meant for the user, like "Not logged in. Run
 * `claude` to authenticate." Anything else surfaces as a generic failure.
 */
export class ProviderError extends Error {}

export function progress(
  label: string,
  used: number,
  limit: number,
  options: {
    format?: ProgressFormat;
    resetsAt?: string | null;
    periodDurationMs?: number | null;
    dependsOn?: string[];
    auxiliary?: boolean;
    detailOnly?: boolean;
  } = {},
): ProgressLine {
  return {
    type: 'progress',
    label,
    used,
    limit,
    format: options.format ?? { kind: 'percent' },
    resetsAt: options.resetsAt ?? null,
    periodDurationMs: options.periodDurationMs ?? null,
    ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
    ...(options.auxiliary ? { auxiliary: true } : {}),
    ...(options.detailOnly ? { detailOnly: true } : {}),
  };
}

export function text(label: string, value: string, subtitle: string | null = null): TextLine {
  return { type: 'text', label, value, subtitle };
}
