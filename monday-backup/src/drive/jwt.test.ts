import { describe, expect, it } from 'vitest';
import { signServiceAccountJwt } from './jwt';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function generateTestCredentials() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const base64 = arrayBufferToBase64(pkcs8);
  const lines = base64.match(/.{1,64}/g) ?? [];
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { privateKeyPem, publicKey: keyPair.publicKey };
}

describe('signServiceAccountJwt', () => {
  it('produces a JWT verifiable with the matching public key', async () => {
    const { privateKeyPem, publicKey } = await generateTestCredentials();
    const jwt = await signServiceAccountJwt(
      { clientEmail: 'backup@svbc.iam.gserviceaccount.com', privateKeyPem },
      'https://www.googleapis.com/auth/drive',
      1000,
    );

    const [encodedHeader, encodedClaims, encodedSignature] = jwt.split('.');
    expect(encodedHeader).toBeDefined();
    expect(encodedClaims).toBeDefined();
    expect(encodedSignature).toBeDefined();

    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedClaims!)));
    expect(claims).toEqual({
      iss: 'backup@svbc.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1000,
      exp: 4600,
    });

    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      base64UrlDecode(encodedSignature!) as BufferSource,
      new TextEncoder().encode(signingInput),
    );
    expect(valid).toBe(true);
  });

  it('accepts a private key with literal backslash-n newlines (as stored via wrangler secret put)', async () => {
    const { privateKeyPem } = await generateTestCredentials();
    const escaped = privateKeyPem.replace(/\n/g, '\\n');
    const jwt = await signServiceAccountJwt(
      { clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem: escaped },
      'scope',
      0,
    );
    expect(jwt.split('.')).toHaveLength(3);
  });
});
