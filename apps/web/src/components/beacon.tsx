'use client';

/**
 * The client beacon.
 *
 * Everything interesting is in `lib/beacon-queue.ts`, which is pure and tested. This
 * file is the browser wiring: the listeners, `sendBeacon`, and the assignment read out
 * of the page.
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT
 * Page views, scroll depth, engaged time, and Core Web Vitals. Not mouse movement, not
 * keystrokes, not clipboard, not form contents, not a session recording. The list is
 * short on purpose: every field here ends up in `docs/PRIVACY.md`, and a measurement
 * nobody can justify in that document does not get collected.
 *
 * It also does nothing at all without analytics consent, and nothing at all for a
 * request the server marked as unmeasurable — a crawler. Both checks happen before the
 * first listener is attached, not before the first send.
 */

import { useEffect } from 'react';
import type { ClientEvent } from '@morph/core';
import { BeaconQueue, chunkForBeacon, type QueueStorage } from '../lib/beacon-queue';
import { allowsAnalytics, maskFromCookieHeader } from '../lib/consent';

interface PageAssignment {
  readonly surfaces: readonly string[];
  readonly variants: readonly string[];
  readonly assignmentHash: string;
  readonly holdout: 0 | 1;
  readonly measurable: boolean;
}

/** The assignment the server rendered, read from the JSON island in the layout. */
function readAssignment(): PageAssignment | null {
  const element = document.getElementById('morph-assignment');
  if (element === null) return null;
  try {
    const parsed = JSON.parse(element.textContent) as PageAssignment;
    return Array.isArray(parsed.surfaces) ? parsed : null;
  } catch {
    return null;
  }
}

/** Analytics consent, read with the same function the server uses. */
function hasAnalyticsConsent(): boolean {
  return allowsAnalytics(maskFromCookieHeader(document.cookie));
}

const localStorageQueue = (key: string): QueueStorage => ({
  read: () => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      // Private windows and storage-blocking extensions throw rather than return null.
      return null;
    }
  },
  write: (value) => {
    window.localStorage.setItem(key, value);
  },
  clear: () => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* see above */
    }
  },
});

export function Beacon(): null {
  useEffect(() => {
    const assignment = readAssignment();
    if (assignment === null || !assignment.measurable) return;
    if (!hasAnalyticsConsent()) return;

    const queue = new BeaconQueue(localStorageQueue('morph_beacon_q'));
    const sessionId = sessionId_();
    let maxScroll = 0;
    let engagedMs = 0;
    let lastTick = Date.now();

    const enqueue = (
      type: ClientEvent['type'],
      value = 0,
      props: Record<string, string> = {},
    ): void => {
      queue.enqueue(
        {
          v: 1,
          eventId: crypto.randomUUID(),
          ts: new Date().toISOString(),
          type,
          sessionId,
          ctx: {
            viewportWidth: window.innerWidth,
            depth: depth_(),
            returning: document.cookie.includes('morph_seen='),
            locale: navigator.language,
          },
          path: window.location.pathname,
          surfaces: [...assignment.surfaces],
          variants: [...assignment.variants],
          assignmentHash: assignment.assignmentHash,
          holdout: assignment.holdout,
          value,
          props,
        },
        Date.now(),
      );
      maybeFlush();
    };

    const send = (events: readonly ClientEvent[], useBeacon: boolean): void => {
      for (const chunk of chunkForBeacon(events)) {
        const body = JSON.stringify({ events: chunk, referrer: document.referrer });

        if (useBeacon && typeof navigator.sendBeacon === 'function') {
          // A failed `sendBeacon` returns false rather than throwing, and there is no
          // second chance once the page is gone — so put the batch back for next time.
          const queued = navigator.sendBeacon('/i', new Blob([body], { type: 'application/json' }));
          if (!queued) queue.restoreFailed(chunk, Date.now());
          continue;
        }

        void fetch('/i', {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
          keepalive: true,
          credentials: 'same-origin',
        }).catch(() => {
          queue.restoreFailed(chunk, Date.now());
        });
      }
    };

    const maybeFlush = (useBeacon = false): void => {
      const reason = useBeacon ? 'page-hidden' : queue.shouldFlush(Date.now());
      if (reason === null) return;
      const events = queue.take();
      if (events.length > 0) send(events, useBeacon);
    };

    // --- scroll depth, sampled rather than measured continuously ---------------
    const onScroll = (): void => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      const pct = Math.round((window.scrollY / scrollable) * 100);
      if (pct > maxScroll) maxScroll = Math.min(100, pct);
    };

    // --- engaged time, counted only while the tab is actually visible ----------
    const tick = (): void => {
      const now = Date.now();
      if (document.visibilityState === 'visible') engagedMs += now - lastTick;
      lastTick = now;
    };

    const onHide = (): void => {
      tick();
      if (maxScroll > 0) enqueue('scroll_depth', maxScroll);
      if (engagedMs > 0) enqueue('engagement', engagedMs);
      maybeFlush(true);
    };

    enqueue('page_view');

    // Check for sign-up completion from OAuth callback redirect (Phase 4, D5)
    const signupMatch = document.cookie.match(/(?:^|;\s*)morph_signup=([a-zA-Z0-9_-]+)/);
    if (signupMatch?.[1]) {
      const provider = signupMatch[1];
      document.cookie = 'morph_signup=; Path=/; Max-Age=0; SameSite=Lax';
      enqueue('signup_complete', 1, { provider });
    }

    const onCustomEvent = (event: Event): void => {
      if (event instanceof CustomEvent && event.detail) {
        const detail = event.detail as {
          type?: ClientEvent['type'];
          value?: number;
          props?: Record<string, string>;
        };
        if (detail.type) {
          enqueue(detail.type, detail.value ?? 0, detail.props ?? {});
        }
      }
    };

    window.addEventListener('morph:event', onCustomEvent);

    const timer = window.setInterval(() => {
      tick();
      maybeFlush();
    }, 5_000);

    window.addEventListener('scroll', onScroll, { passive: true });
    // `pagehide` rather than `unload`: `unload` is unreliable on mobile Safari and
    // disqualifies the page from the back/forward cache on every browser.
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', tick);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('morph:event', onCustomEvent);
      document.removeEventListener('visibilitychange', tick);
      onHide();
    };
  }, []);

  return null;
}

/** A session id that dies with the tab. Never a cookie, never persisted. */
function sessionId_(): string {
  const key = 'morph_session';
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing !== null) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

/** Pageviews so far in this session, capped so the feature stays bounded. */
function depth_(): number {
  const key = 'morph_depth';
  try {
    const next = Math.min(50, Number.parseInt(window.sessionStorage.getItem(key) ?? '0', 10) + 1);
    window.sessionStorage.setItem(key, String(next));
    return next;
  } catch {
    return 1;
  }
}

/**
 * Dispatch an analytics event through the client beacon.
 *
 * Events flow into the in-memory/localStorage queue and are flushed to `/i`.
 */
export function emitClientEvent(
  type: ClientEvent['type'],
  value = 0,
  props: Record<string, string> = {},
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('morph:event', {
      detail: { type, value, props },
    }),
  );
}
