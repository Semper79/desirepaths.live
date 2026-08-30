/**
 * The public brand name, for the console's own chrome.
 *
 * A three-line copy rather than an import: `apps/admin` cannot depend on `apps/web`, where
 * `siteIdentity()` lives, because packages may be shared between apps and apps may not.
 * Duplicating one string is the smaller wrong — and the rule in `CLAUDE.md` says a string
 * a person reads says Desire Path, which is what this returns.
 */
export function siteName(): string {
  return 'Desire Path';
}
