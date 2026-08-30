/**
 * The thinking bar.
 *
 * The one thing on this site a stranger will screenshot. It reports how much the engine
 * currently knows — derived, every time, from the same posteriors that chose the page
 * around it.
 *
 * WHY IT IS NOT A SECTION
 * It is rendered outside `sectionOrder` and has no entry in the surface registry, so the
 * bandit cannot move it, restyle it, or reorder it away. That is deliberate and it is the
 * whole reason the number can be trusted: an optimiser given control of the display of its
 * own scorecard would discover which presentation keeps people reading, and would then be
 * showing the most engaging reading rather than the true one. `thinking-bar.test.tsx`
 * asserts the registry still has no entry for it.
 *
 * WHY THERE IS NO JAVASCRIPT
 * The number is in the initial HTML. That keeps it visible to crawlers and answer engines
 * — which is the point, since a live, checkable, quotable figure is exactly the kind of
 * thing that gets cited — and it means the bar is correct with scripts blocked, like the
 * consent gate. A ticking animation would be theatre; the value only changes when the
 * worker publishes a new snapshot, so a page that re-rendered it every second would be
 * animating nothing.
 */

import type { Sophistication } from '@morph/adaptive';

/** Whole percentage points. The precision the underlying estimate actually supports. */
function percent(level: number): number {
  return Math.round(level * 100);
}

export function ThinkingBar({ reading }: { readonly reading: Sophistication }): React.JSX.Element {
  const value = percent(reading.level);

  return (
    <section className="thinking" aria-labelledby="thinking-heading">
      <div className="thinking-head">
        <h2 id="thinking-heading">How much this site knows</h2>
        <p className="thinking-value">
          <strong>{value}%</strong>
          <span className="thinking-label">{reading.label}</span>
        </p>
      </div>

      {/*
        A meter, not a progressbar. A progressbar promises a task that will finish; this
        is a level that moves in both directions, and it drops after a retirement or a
        rollback. Screen readers describe the two differently and the difference is real.
      */}
      <div
        className="thinking-track"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${String(value)} per cent — ${reading.label}`}
        aria-describedby="thinking-reason"
      >
        <div className="thinking-fill" style={{ inlineSize: `${String(value)}%` }} />
      </div>

      <p id="thinking-reason" className="muted">
        {reading.reason}
      </p>

      {/*
        The breakdown, because a single number invites the question and a page that raises
        a question it will not answer is worse than one that stayed quiet. It is also the
        part a competitor cannot copy without building the engine underneath it.
      */}
      <dl className="thinking-parts">
        <Part label="Evidence" value={reading.components.evidence} />
        <Part label="Certainty" value={reading.components.certainty} />
        <Part label="Breadth" value={reading.components.breadth} />
        <Part label="Freshness" value={reading.components.freshness} />
      </dl>

      <p className="muted thinking-foot">
        Measured across {reading.surfacesOptimising} of {reading.surfacesTotal} surfaces from{' '}
        {reading.observations.toLocaleString('en-GB')} observations. This figure is read from the
        same decision the page above was built with — it is not an illustration.
      </p>

      {/*
        The link out, and the most important one on the page.

        A site that says "I rewrite myself" and offers nowhere to check is asking to be
        taken on faith, which is the one thing this product cannot ask for. `/proof` is
        where the claim becomes checkable, and a reader who has just read a number they
        did not expect is exactly the reader who will follow it.
      */}
      <p className="thinking-more">
        <a href="/proof">See what it has worked out →</a>
      </p>
    </section>
  );
}

function Part({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | null;
}): React.JSX.Element {
  return (
    <div className="thinking-part">
      <dt>{label}</dt>
      {/*
        Null is a component that could not be measured, and it says so rather than
        rendering a zero. A dash is the difference between "this is bad" and "this is
        unknown", and collapsing the two is how a dashboard starts lying.
      */}
      <dd>
        {value === null ? (
          <span title="not measurable right now">—</span>
        ) : (
          `${String(percent(value))}%`
        )}
      </dd>
    </div>
  );
}
