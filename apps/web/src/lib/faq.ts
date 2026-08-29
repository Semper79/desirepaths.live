/**
 * The questions this site answers, and the answers.
 *
 * Kept out of the page module for two reasons. The mechanical one: a Next page may
 * only export a known set of names, so exporting a constant from it fails the build.
 * The real one: these answers are emitted twice — as markup a human reads and as
 * `FAQPage` structured data an answer engine quotes — and a single definition is the
 * only way those two cannot drift.
 *
 * THE CONSTRAINT ON WRITING THEM
 * Every answer must stand alone. An answer engine quotes one and drops the rest of the
 * page, so "as described above", a pronoun whose referent is elsewhere, or a number
 * that only makes sense next to the previous paragraph all become nonsense the moment
 * they are useful. Each answer below is written to survive being the only thing quoted.
 */

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: 'What does Desire Path actually change?',
    answer:
      'Desire Path changes eleven things about itself: the headline, the hero media, the colour palette, the typography, the layout density, the order of the page sections, the call-to-action copy and its visual style, the order of the sign-in buttons, the motion intensity, and how the content feed is ranked.',
  },
  {
    question: 'How does Desire Path decide what to show?',
    answer:
      'Desire Path uses Thompson sampling over Beta posteriors for robustness, blended with a contextual bandit that conditions on device, referrer class, hour of week and session depth. A composite reward weights sign-ups at 40%, meaningful engagement at 25%, scroll depth at 20%, return visits at 10% and shares at 5%, minus a bounce penalty.',
  },
  {
    question: 'How do you know the adaptation is working?',
    answer:
      'Five percent of visitors to Desire Path are pinned to an un-adapted baseline. The measured difference between that holdout cohort and everyone else is the lift of the whole system. It is reported every hour with an always-valid p-value, so that looking at the result continuously does not inflate the false-positive rate the way a conventional A/B test would.',
  },
  {
    question: 'Does Desire Path track people across sites?',
    answer:
      'No. Desire Path measures behaviour first-party and without cookies, using a daily-rotating salted hash of IP address and user agent. The raw IP address is never stored. There are no third-party analytics, no advertising pixels, and no cross-site identifiers of any kind.',
  },
  {
    question: 'What do search engines and AI crawlers see?',
    answer:
      'Desire Path serves every automated request the un-adapted baseline — byte for byte what the holdout cohort sees. The indexed version of a page is therefore stable between crawls, and the site never shows a crawler something different from what a person would see on the same baseline.',
  },
] as const;
