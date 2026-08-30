/**
 * The surfaces view.
 *
 * The closed world of what the site may change about itself, joined to what the engine
 * currently believes about each option. This is the view that exists nowhere else: the
 * Telegram report says what changed this hour, and this says what *could* change and what
 * the evidence says about each choice.
 *
 * Server-rendered with no client JavaScript. A console that needs a bundle to load is a
 * console that fails in exactly the conditions it is opened for.
 */

import { surfaceRows } from '../lib/surfaces.js';
import { readSnapshot } from '../lib/snapshot.js';
import { siteName } from '../lib/branding.js';

export const dynamic = 'force-dynamic';

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function age(generatedAt: number): string {
  if (generatedAt === 0) return 'never published';

  const minutes = Math.round((Date.now() - generatedAt) / 60_000);
  if (minutes < 90) return `${String(minutes)} min ago`;
  return `${String(Math.round(minutes / 60))} h ago`;
}

const cell = { padding: '10px 12px', borderBottom: '1px solid var(--color-border)' } as const;
const muted = { color: 'var(--color-text-muted)' } as const;

export default async function SurfacesPage() {
  const snapshot = await readSnapshot();
  const rows = surfaceRows(snapshot.arms);
  const optimising = rows.filter((row) => row.idleReason === null).length;

  return (
    <>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 30, margin: '0 0 6px' }}>
          {siteName()} — surfaces
        </h1>
        <p style={{ ...muted, margin: 0 }}>
          {optimising} of {rows.length} surfaces are being optimised. Snapshot{' '}
          {age(snapshot.generatedAt)}
          {snapshot.adaptationEnabled ? '' : ' — adaptation is switched off'}.
        </p>
      </header>

      {snapshot.generatedAt === 0 ? (
        <p
          style={{
            ...muted,
            padding: '14px 16px',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            marginBottom: 32,
          }}
        >
          No posteriors have been published yet, so every surface below is showing its declared
          variant space and nothing more. The adapt job publishes hourly; until it has, the site
          serves baselines.
        </p>
      ) : null}

      {rows.map((row) => (
        <section key={row.key} style={{ marginBottom: 40 }}>
          <h2 style={{ fontSize: 17, margin: '0 0 4px', fontFamily: 'var(--font-display)' }}>
            {row.key}
          </h2>
          <p style={{ ...muted, margin: '0 0 12px', fontSize: 14 }}>{row.description}</p>

          {row.idleReason === null ? null : (
            <p style={{ ...muted, margin: '0 0 12px', fontSize: 14 }}>
              <strong style={{ color: 'var(--color-accent)' }}>Idle:</strong> {row.idleReason}
            </p>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', ...muted }}>
                <th style={cell}>Variant</th>
                <th style={cell}>Reward</th>
                <th style={cell}>Impressions</th>
                <th style={cell}>P(beats leader)</th>
              </tr>
            </thead>
            <tbody>
              {row.variants.map((variant) => (
                <tr key={variant.variantId}>
                  <td style={cell}>
                    <code>{variant.variantId}</code>
                    {variant.isLeader ? (
                      <span style={{ color: 'var(--color-accent)' }}> · leader</span>
                    ) : null}
                    {variant.isBaseline ? <span style={muted}> · baseline</span> : null}
                  </td>
                  <td style={cell}>{percent(variant.posteriorMean)}</td>
                  <td style={cell}>
                    {variant.impressions === null
                      ? '—'
                      : variant.impressions.toLocaleString('en-GB')}
                  </td>
                  <td style={cell}>{variant.isLeader ? '—' : percent(variant.probabilityBest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
