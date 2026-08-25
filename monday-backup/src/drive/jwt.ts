export interface ServiceAccountCredentials {
  clientEmail: string;
  privateKeyPem: string;
}

function base64UrlEncode(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): ArrayBuffer {
  // Service-account JSON keys carry literal "\n" in their private_key field; a value
  // passed in via `wrangler secret put` should already have real newlines, but strip
  // either form defensively before base64-decoding the PKCS8 body.
  const base64 = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Signs a Google service-account JWT bearer assertion (RFC 7523) for the OAuth2 token
// endpoint, using Workers' native Web Crypto — no `googleapis`/`jsonwebtoken` package,
// matching this repo's fetch-only convention for calling Google APIs (see
// salesforce-import/src/geocode/google.ts, which does the same for Geocoding/Places).
export async function signServiceAccountJwt(
  credentials: ServiceAccountCredentials,
  scope: string,
  nowSeconds: number,
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: credentials.clientEmail,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(credentials.privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64UrlEncode(signature)}`;
}
