// src/auth.js — Authentication helpers for Google ID tokens, sync codes, and session JWTs

function base64UrlEncode(data) {
  let str = '';
  if (typeof data === 'string') {
    str = btoa(data);
  } else {
    const bytes = new Uint8Array(data);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    str = btoa(str);
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

function base64UrlDecodeToBuffer(str) {
  const binary = base64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ----------------------------------------------------------------------------
// Session Token (HMAC-SHA256 JWT)
// ----------------------------------------------------------------------------

export async function createSessionToken(accountId, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const payload = {
    sub: accountId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 30 * 24 * 60 * 60, // 30 days
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, dataToSign);
  const sigB64 = base64UrlEncode(sig);

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export async function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBytes = base64UrlDecodeToBuffer(sigB64);

    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, dataToSign);
    if (!valid) return null;

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return null; // Expired
    }

    return { accountId: payload.sub };
  } catch (err) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Sync Code (128-bit random alphanumeric)
// ----------------------------------------------------------------------------

export function generateSyncCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Crockford-style readable alphabet (no O, I, L to prevent confusion)
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let codeStr = '';
  for (let i = 0; i < bytes.length; i++) {
    codeStr += alphabet[bytes[i] % alphabet.length];
  }
  // Format as 4 groups of 4: XXXX-XXXX-XXXX-XXXX
  return `${codeStr.slice(0, 4)}-${codeStr.slice(4, 8)}-${codeStr.slice(8, 12)}-${codeStr.slice(12, 16)}`;
}

export async function hashSyncCode(code) {
  let normalized = (code || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  // Map commonly confused characters to their numeric equivalents
  normalized = normalized.replace(/O/g, '0').replace(/[IL]/g, '1');
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ----------------------------------------------------------------------------
// Google ID Token Verification (RS256 via Google Public JWKS)
// ----------------------------------------------------------------------------

let cachedGoogleJwks = null;
let googleJwksExpiresAt = 0;

async function getGoogleJwks() {
  const now = Date.now();
  if (cachedGoogleJwks && now < googleJwksExpiresAt) {
    return cachedGoogleJwks;
  }

  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) {
    throw new Error('Failed to fetch Google JWKS');
  }

  const data = await res.json();
  cachedGoogleJwks = data.keys || [];
  googleJwksExpiresAt = now + 6 * 60 * 60 * 1000; // cache for 6 hours
  return cachedGoogleJwks;
}

export async function verifyGoogleIdToken(idToken, expectedClientId) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing ID token');
  }
  if (!expectedClientId) {
    throw new Error('Missing expected Google client ID configuration');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBuffer(payloadB64)));

  // Check expiration
  if (!payload.exp || payload.exp * 1000 < Date.now()) {
    throw new Error('Google token has expired');
  }

  // Check issuer
  const validIssuers = ['https://accounts.google.com', 'accounts.google.com'];
  if (!validIssuers.includes(payload.iss)) {
    throw new Error('Invalid token issuer');
  }

  // Check audience if configured
  if (expectedClientId && payload.aud !== expectedClientId) {
    throw new Error('Token audience does not match GOOGLE_CLIENT_ID');
  }

  // Verify RS256 signature using Google's public key
  const keys = await getGoogleJwks();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    throw new Error(`Public key with kid "${header.kid}" not found in Google JWKS`);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: 'RS256',
      ext: true,
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlDecodeToBuffer(sigB64);

  const isValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sigBytes, dataToVerify);
  if (!isValid) {
    throw new Error('Google token signature verification failed');
  }

  return {
    sub: payload.sub,
    email: payload.email || null,
    name: payload.name || null,
  };
}
