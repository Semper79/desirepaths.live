/**
 * The consent gate.
 *
 * A server component rendering a plain form. No client JavaScript, no state, no
 * library — which is not minimalism for its own sake: it means the gate works with
 * scripts blocked, and the visitor most likely to be blocking scripts is exactly the
 * one most likely to be refusing.
 *
 * WHAT MAKES THIS A REAL GATE RATHER THAN A BANNER
 *
 *  - Refusing is exactly as easy as accepting. Same element, same weight, adjacent.
 *    No "manage preferences" detour to reach "no".
 *  - Nothing is pre-selected, and there is no dismissal — the choice has to be made.
 *  - It is small. A banner that fills the viewport makes refusing feel like an
 *    obstruction, and on a phone it is indistinguishable from a modal. Two sentences
 *    here; the detail is on /privacy, where someone who wants it will read it.
 *  - The site works either way. Refusing pins the visitor to the baseline — what the
 *    5% holdout cohort already sees, so a known-good experience rather than a penalty.
 *  - **This is not an adaptive surface, and never will be.** It is absent from the
 *    registry by design. An optimiser pointed at a consent rate produces a dark pattern
 *    by construction: that is not a risk, it is what optimising that number means.
 */

import { headers } from 'next/headers';
import { hasChosen } from '../lib/consent';

export async function ConsentGate(): Promise<React.JSX.Element | null> {
  if (hasChosen((await headers()).get('cookie'))) return null;

  return (
    <aside className="consent" aria-labelledby="consent-heading">
      <div className="shell consent-row">
        <div className="consent-copy">
          <h2 id="consent-heading" style={{ fontSize: '1rem', margin: '0 0 0.25rem' }}>
            How Desire Path measures you
          </h2>
          <p className="muted consent-copy">
            Measurement is first-party and cookieless, with an identifier that rotates daily and
            never leaves this site; your IP address is never stored. Say no and you get the same
            un-adapted baseline that 5% of visitors always see —{' '}
            <a href="/privacy">the detail is here</a>.
          </p>
        </div>

        <form method="post" action="/api/consent" className="consent-actions">
          <input type="hidden" name="next" value="/" />
          {/*
            Order and weight are identical. The refusal is first because a reader
            scanning left to right should meet "no" before "yes", not after it.
          */}
          <button className="cta" type="submit" name="choice" value="necessary">
            No, necessary only
          </button>
          <button className="cta" type="submit" name="choice" value="analytics">
            Yes, measure anonymously
          </button>
        </form>
      </div>
    </aside>
  );
}
