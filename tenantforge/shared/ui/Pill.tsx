import type { PillTone } from './types.js';

/**
 * A small status badge ("Pill") in the Cloudflare dashboard style.
 *
 * Tone sets a token-driven color pair, but the **text inside the pill always carries the meaning** —
 * color is only an enhancement (WCAG 1.4.1, never color-only). Render the status word as the child.
 */
export function Pill(props: { tone?: PillTone; children: React.ReactNode }): React.ReactElement {
  const tone = props.tone ?? 'neutral';
  return <span className={`cf-pill cf-pill-${tone}`}>{props.children}</span>;
}
