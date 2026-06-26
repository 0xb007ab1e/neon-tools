import { useId } from 'react';

/**
 * A titled content card in the Cloudflare dashboard style: a surface panel on the page's gray
 * background, with a header (title + optional helper text + optional right-aligned actions) and a body.
 *
 * Accessibility: the card is a labelled `<section>` (its heading labels the region via `aria-labelledby`),
 * so screen-reader users get a navigable landmark per card. The heading level is configurable so the
 * card sits correctly in the page's heading outline (default `h2`).
 */
export function Card(props: {
  title: string;
  /** Optional helper/description text under the title. */
  description?: React.ReactNode;
  /** Optional right-aligned header actions (e.g. an Edit button). */
  actions?: React.ReactNode;
  /** Heading level for the title (default 2). */
  headingLevel?: 2 | 3;
  children: React.ReactNode;
}): React.ReactElement {
  const titleId = useId();
  const Heading = props.headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section className="cf-card" aria-labelledby={titleId}>
      <div className="cf-card-head">
        <div className="cf-card-head-text">
          <Heading id={titleId} className="cf-card-title">
            {props.title}
          </Heading>
          {props.description !== undefined && <p className="cf-card-desc">{props.description}</p>}
        </div>
        {props.actions !== undefined && <div className="cf-card-actions">{props.actions}</div>}
      </div>
      <div className="cf-card-body">{props.children}</div>
    </section>
  );
}
