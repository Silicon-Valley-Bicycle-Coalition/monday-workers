// AES-256-GCM for the OAuth pair in qb_oauth_tokens (GL#68), so that reading D1 alone doesn't yield a
// live QuickBooks credential. The key is the QB_TOKEN_ENCRYPTION_KEY Worker secret.
//
// A stored value is `enc:v1:<base64 iv>:<base64 ciphertext>`. Each column's name is authenticated
// with it, so a ciphertext copied into the other column fails to decrypt. A value without the
// prefix is plaintext: that's a pair seeded by hand (README "OAuth tokens"), and the first refresh
// replaces it with an encrypted one.
const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type TokenColumn = 'access_token' | 'refresh_token';

const KEY_HELP = 'QB_TOKEN_ENCRYPTION_KEY must be 32 bytes of base64 (`openssl rand -base64 32`)';

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export class TokenCipher {
  private constructor(private key: CryptoKey) {}

  // Throws on a missing or malformed key. Error messages here never carry a key or a token.
  static async load(secret: string | undefined): Promise<TokenCipher> {
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = fromBase64(secret ?? '');
    } catch {
      throw new Error(`quickbooks oauth: ${KEY_HELP}`);
    }
    if (raw.length !== KEY_BYTES) throw new Error(`quickbooks oauth: ${KEY_HELP}`);
    return new TokenCipher(await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }

  async encrypt(plaintext: string, column: TokenColumn): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(column) },
      this.key,
      new TextEncoder().encode(plaintext)
    );
    return `${PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
  }

  async decrypt(stored: string, column: TokenColumn): Promise<string> {
    if (!stored.startsWith(PREFIX)) return stored;
    try {
      const [iv, ciphertext] = stored.slice(PREFIX.length).split(':');
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(iv!), additionalData: new TextEncoder().encode(column) },
        this.key,
        fromBase64(ciphertext!)
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new Error(
        `quickbooks oauth: could not decrypt ${column} — restore the QB_TOKEN_ENCRYPTION_KEY it was saved under, or re-seed the token pair (README "OAuth tokens")`
      );
    }
  }
}
