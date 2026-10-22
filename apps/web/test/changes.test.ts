/**
 * The changelog's wording.
 *
 * Every sentence here is published under the site's name and read by somebody who does
 * not work on it. The tests are about the two ways that goes wrong: leaking an internal
 * identifier into a sentence meant for a stranger, and claiming more activity than the
 * log actually records.
 */

import { describe, expect, it } from 'vitest';
import { changesFrom, summarise, type AdaptationRow } from '../src/lib/changes';

const NOW = Date.parse('2026-08-30T12:00:00Z');
const HOUR = 3_600_000;

function row(overrides: Partial<AdaptationRow> = {}): AdaptationRow {
  return {
    occurredAt: NOW - 3 * HOUR,
    action: 'retired',
    surfaceId: 'hero.headline',
    variantId: 'hero.headline#playful',
    reason:
      'Retired hero.headline#playful — 96% probability of being worse than hero.headline#v0 over 3.1k impressions.',
    stats: { impressions: 3_100 },
    ...overrides,
  };
}

describe('changesFrom', () => {
  it('writes a title a stranger could read', () => {
    // "Retired hero.headline#7" is a sentence for somebody who already knows what
    // hero.headline is. The identifier belongs in the detail line, not the headline.
    const [change] = changesFrom([row()]);

    expect(change?.title).toBe('Stopped using one version of its opening line');
    expect(change?.title).not.toContain('hero.headline');
  });

  it('keeps the operator’s reason word for word', () => {
    // Rewriting it into something friendlier would put a gap between what the operator was
    // told and what the public was told, and this page exists because there is no gap.
    const source = row();
    const [change] = changesFrom([source]);

    expect(change?.detail).toBe(source.reason);
  });

  it('describes a surface it has never heard of without leaking the id', () => {
    // A surface added after this map was written should read as slightly vague, never as
    // a raw identifier in the middle of a sentence.
    const [change] = changesFrom([row({ surfaceId: 'surface.invented_later' })]);

    expect(change?.title).toBe('Stopped using one version of one of its own settings');
    expect(change?.title).not.toContain('surface.invented_later');
  });

  it('distinguishes a quarantine from a retirement', () => {
    // Different mechanisms with different meanings: one is the reward statistics settling,
    // the other is the health guardrail pulling something that was doing harm.
    const [change] = changesFrom([row({ action: 'quarantined' })]);

    expect(change?.action).toBe('quarantined');
    expect(change?.title).toContain('harming the experience');
  });

  it('falls back to a neutral phrasing for an action it does not model', () => {
    const [change] = changesFrom([row({ action: 'rolled_back' })]);

    expect(change?.action).toBe('other');
    expect(change?.title).toContain('Changed');
  });

  it('drops entries with no surface, which are operator bookkeeping', () => {
    const changes = changesFrom([row(), row({ surfaceId: null })]);

    expect(changes).toHaveLength(1);
  });

  it('orders newest first', () => {
    const changes = changesFrom([
      row({ occurredAt: NOW - 40 * HOUR, surfaceId: 'cta.copy' }),
      row({ occurredAt: NOW - HOUR }),
    ]);

    expect(changes[0]?.surfaceId).toBe('hero.headline');
  });

  it('gives every entry a stable id, so a feed reader does not re-announce it', () => {
    // Derived from the facts rather than from a row id: the log is partitioned monthly and
    // its ids do not survive a partition detach, which would republish the whole feed.
    const first = changesFrom([row()])[0];
    const second = changesFrom([row()])[0];

    expect(first?.id).toBe(second?.id);
    expect(first?.id).toContain('hero.headline');
  });

  it('reports a missing impression count as unknown rather than zero', () => {
    const [change] = changesFrom([row({ stats: {} })]);

    expect(change?.impressions).toBeNull();
  });
});

describe('summarise', () => {
  it('says nothing has changed when nothing has', () => {
    // The state every visitor sees before the first cycle. Claiming activity here would be
    // the fastest way to make the rest of the page not worth reading.
    expect(summarise([], NOW)).toContain('has not changed anything about itself yet');
  });

  it('counts the last seven days rather than the whole log', () => {
    // A site claiming to change constantly, on a page listing three changes in a month,
    // has undermined itself more effectively than any critic could.
    const changes = changesFrom([
      row({ occurredAt: NOW - 2 * HOUR }),
      row({ occurredAt: NOW - 3 * HOUR, surfaceId: 'cta.copy' }),
      row({ occurredAt: NOW - 40 * 24 * HOUR, surfaceId: 'theme.palette' }),
    ]);

    const sentence = summarise(changes, NOW);

    expect(sentence).toContain('2 changes in the last seven days');
  });

  it('falls back to the total when the last week was quiet', () => {
    const changes = changesFrom([row({ occurredAt: NOW - 30 * 24 * HOUR })]);

    expect(summarise(changes, NOW)).toContain('1 changes on record');
  });
});
