import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Shared AES-256-GCM encryption for OAuth tokens at rest.
 * Wire format: `<iv_hex>:<tag_hex>:<ciphertext_hex>`, interoperable with
 * `vozcore/vozcore/security.py` so Python agents can use OAuth tokens
 * stored by the Node OAuth callback without ever exposing plaintext tokens.
 */
function deriveKey(secret = env.JWT_SECRET): Buffer {
  return crypto.createHash('sha256').update(`vozpilot-oauth-v1:${secret}`, 'utf8').digest();
}

export function encryptToken(plaintext: string, secret?: string): string {
  if (!plaintext) return '';
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(encoded: string | null | undefined, secret?: string): string | null {
  if (!encoded) return null;
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('Stored OAuth token format is invalid.');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}
