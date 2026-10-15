import { describe, it, expect } from 'vitest';
import {
  generateSyncCode,
  hashSyncCode,
  createSessionToken,
  verifySessionToken,
} from '../src/auth.js';

describe('Auth module', () => {
  it('generates a valid formatted sync code', () => {
    const code = generateSyncCode();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('hashes sync code consistently and normalizes whitespace/casing', async () => {
    const hash1 = await hashSyncCode('1234-abcd-5678-efgh');
    const hash2 = await hashSyncCode('1234ABCD5678EFGH');
    const hash3 = await hashSyncCode(' 1234-ABCD-5678-efgh ');
    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
    expect(hash1).toHaveLength(64); // SHA-256 hex string

    // Normalizes visually ambiguous characters: O -> 0, I -> 1, L -> 1
    const hashZero = await hashSyncCode('0000-1111-2222-3333');
    const hashAmbiguous = await hashSyncCode('OOOO-IIII-2222-3333');
    const hashAmbiguousL = await hashSyncCode('0000-LLLL-2222-3333');
    expect(hashAmbiguous).toBe(hashZero);
    expect(hashAmbiguousL).toBe(hashZero);
  });

  it('creates and verifies session tokens', async () => {
    const secret = 'super-secret-test-key-12345';
    const accountId = 'user_test_uuid_456';
    const token = await createSessionToken(accountId, secret);
    expect(token.split('.')).toHaveLength(3);

    const verified = await verifySessionToken(token, secret);
    expect(verified).not.toBeNull();
    expect(verified.accountId).toBe(accountId);

    // Fails with wrong secret
    const wrongSecret = await verifySessionToken(token, 'wrong-secret');
    expect(wrongSecret).toBeNull();

    // Rejects null, empty, or malformed tokens
    expect(await verifySessionToken(null, secret)).toBeNull();
    expect(await verifySessionToken('invalid.token', secret)).toBeNull();
    expect(await verifySessionToken('a.b.c', secret)).toBeNull();
  });
});
