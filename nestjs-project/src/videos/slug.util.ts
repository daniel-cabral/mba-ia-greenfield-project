import { randomBytes } from 'crypto';

const SLUG_BYTES = 8;

/** 8 random bytes in base64url: 11 characters, ~64 bits of entropy. */
export function generateSlug(): string {
  return randomBytes(SLUG_BYTES).toString('base64url');
}
