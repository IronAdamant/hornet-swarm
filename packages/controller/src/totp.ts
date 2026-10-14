import { createHmac } from 'node:crypto';

/** An authenticator code is good for 30 seconds. A code handed over with less than this left could expire before it is typed. */
export const TOTP_FRESH_MS = 15_000;

/** How long to wait so the next code made has at least TOTP_FRESH_MS left. Zero when the current one has enough. */
export function waitForFreshCode(now = Date.now(), freshMs = TOTP_FRESH_MS): number {
  const left = 30_000 - (now % 30_000);
  return left < freshMs ? left + 50 : 0;
}

export function totpCode(secret: string, now = Date.now()): string {
  const key = base32Decode(secret.replace(/\s/g, '').toUpperCase());
  const counter = Math.floor(now / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.replace(/=+$/g, '')) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}
