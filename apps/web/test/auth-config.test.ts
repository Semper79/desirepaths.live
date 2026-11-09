import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { getAppleClientSecret } from '../src/lib/auth/apple';
import { configuredProviders } from '../src/lib/auth/providers';
import { GET as readyGet } from '../src/app/api/ready/route';

describe('Readiness probe (/api/ready)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('fails with 503 and lists AUTH_SECRET when unset or short', async () => {
    delete process.env['AUTH_SECRET'];
    process.env['ANON_ID_PEPPER'] = 'a'.repeat(32);
    process.env['MORPH_PUBLIC_URL'] = 'https://desirepath.live';
    process.env['MORPH_CONTROLLER_NAME'] = 'Acme Inc';
    process.env['MORPH_CONTROLLER_ADDRESS'] = '123 Street';
    process.env['MORPH_CONTROLLER_EMAIL'] = 'privacy@example.com';
    process.env['MORPH_CONTROLLER_DPO_EMAIL'] = 'dpo@example.com';

    const res = await readyGet();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean; missing: string[] };
    expect(body.ready).toBe(false);
    expect(body.missing).toContain('AUTH_SECRET');

    // Short secret (< 32 chars)
    process.env['AUTH_SECRET'] = 'too-short';
    const resShort = await readyGet();
    expect(resShort.status).toBe(503);
    const bodyShort = (await resShort.json()) as { ready: boolean; missing: string[] };
    expect(bodyShort.missing).toContain('AUTH_SECRET');
  });

  it('succeeds with 200 when AUTH_SECRET and other invariants are satisfied', async () => {
    process.env['AUTH_SECRET'] = 'b'.repeat(32);
    process.env['ANON_ID_PEPPER'] = 'a'.repeat(32);
    process.env['MORPH_PUBLIC_URL'] = 'https://desirepath.live';
    process.env['MORPH_CONTROLLER_NAME'] = 'Acme Inc';
    process.env['MORPH_CONTROLLER_ADDRESS'] = '123 Street';
    process.env['MORPH_CONTROLLER_EMAIL'] = 'privacy@example.com';
    process.env['MORPH_CONTROLLER_DPO_EMAIL'] = 'dpo@example.com';

    const res = await readyGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; missing: string[] };
    expect(body.ready).toBe(true);
    expect(body.missing).toHaveLength(0);
  });
});

describe('Apple client secret generation (D5)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns static secret if AUTH_APPLE_SECRET is set', async () => {
    process.env['AUTH_APPLE_SECRET'] = 'static-jwt-secret';
    const secret = await getAppleClientSecret();
    expect(secret).toBe('static-jwt-secret');
  });

  it('returns null if any dynamic secret config is missing', async () => {
    delete process.env['AUTH_APPLE_SECRET'];
    process.env['AUTH_APPLE_KEY_ID'] = 'KEY123';
    process.env['AUTH_APPLE_TEAM_ID'] = 'TEAM456';
    // AUTH_APPLE_ID and AUTH_APPLE_PRIVATE_KEY missing
    expect(await getAppleClientSecret()).toBeNull();
  });

  it('generates a signed ES256 JWT when private key and IDs are present', async () => {
    delete process.env['AUTH_APPLE_SECRET'];
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const pkcs8Pem = await exportPKCS8(privateKey);

    process.env['AUTH_APPLE_KEY_ID'] = 'KEY123';
    process.env['AUTH_APPLE_TEAM_ID'] = 'TEAM456';
    process.env['AUTH_APPLE_ID'] = 'live.desirepath.auth';
    process.env['AUTH_APPLE_PRIVATE_KEY'] = pkcs8Pem;

    const jwt = await getAppleClientSecret();
    expect(jwt).not.toBeNull();
    expect(typeof jwt).toBe('string');

    // Verify claims with public key
    const verified = await jwtVerify(jwt!, publicKey, {
      audience: 'https://appleid.apple.com',
      issuer: 'TEAM456',
      subject: 'live.desirepath.auth',
    });

    expect(verified.protectedHeader.kid).toBe('KEY123');
    expect(verified.protectedHeader.alg).toBe('ES256');
  });
});

describe('Configured OAuth providers (D5)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns an empty list when no provider credentials exist', async () => {
    delete process.env['AUTH_GOOGLE_ID'];
    delete process.env['AUTH_GOOGLE_SECRET'];
    delete process.env['AUTH_APPLE_ID'];
    delete process.env['AUTH_APPLE_SECRET'];
    delete process.env['AUTH_DISCORD_ID'];
    delete process.env['AUTH_DISCORD_SECRET'];
    delete process.env['AUTH_TIKTOK_ID'];
    delete process.env['AUTH_TIKTOK_SECRET'];
    delete process.env['AUTH_PASSKEY_ENABLED'];

    const providers = await configuredProviders();
    expect(providers).toHaveLength(0);
  });

  it('includes configured providers when credentials exist', async () => {
    process.env['AUTH_GOOGLE_ID'] = 'gid';
    process.env['AUTH_GOOGLE_SECRET'] = 'gsec';
    process.env['AUTH_DISCORD_ID'] = 'did';
    process.env['AUTH_DISCORD_SECRET'] = 'dsec';
    process.env['AUTH_PASSKEY_ENABLED'] = 'true';

    const providers = await configuredProviders();
    const ids = providers.map((p) => (typeof p === 'function' ? p().id : p.id));
    expect(ids).toContain('google');
    expect(ids).toContain('discord');
    expect(ids).toContain('passkey');
    expect(ids).not.toContain('apple');
    expect(ids).not.toContain('tiktok');
  });
});

describe('Auth.js secret (no fallback)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to start without AUTH_SECRET instead of using a value from the repository', async () => {
    const { authSecret } = await import('../src/lib/auth/secret');
    delete process.env['AUTH_SECRET'];
    expect(() => authSecret()).toThrow(/AUTH_SECRET/);
  });

  it('refuses a secret shorter than the readiness probe accepts', async () => {
    const { authSecret } = await import('../src/lib/auth/secret');
    process.env['AUTH_SECRET'] = 'x'.repeat(31);
    expect(() => authSecret()).toThrow(/AUTH_SECRET/);
  });

  it('returns a sufficient secret unchanged', async () => {
    const { authSecret } = await import('../src/lib/auth/secret');
    process.env['AUTH_SECRET'] = 'y'.repeat(32);
    expect(authSecret()).toBe('y'.repeat(32));
  });
});

describe('Passkey opt-in', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('turns WebAuthn on in the Auth.js config only when passkeys are enabled', async () => {
    const { createAuthConfig } = await import('../src/lib/auth/config');
    process.env['AUTH_SECRET'] = 'z'.repeat(32);

    delete process.env['AUTH_PASSKEY_ENABLED'];
    expect((await createAuthConfig()).experimental).toBeUndefined();

    process.env['AUTH_PASSKEY_ENABLED'] = 'true';
    expect((await createAuthConfig()).experimental).toEqual({ enableWebAuthn: true });
  });
});
