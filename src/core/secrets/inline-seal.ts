import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR_NAME } from '../constants.js';

const SALT_FILE = path.join(os.homedir(), STATE_DIR_NAME, '.machine-salt');
const VERSION_TAG = 'v1';

function readOrCreateSalt(): Buffer {
  try {
    const raw = fs.readFileSync(SALT_FILE);
    if (raw.length >= 32) return raw.subarray(0, 32);
  } catch {}
  const salt = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(SALT_FILE), { recursive: true });
    fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 });
  } catch {}
  return salt;
}

function deriveKey(): Buffer {
  const salt = readOrCreateSalt();
  const material = Buffer.concat([
    Buffer.from(os.hostname() || 'pikiloom'),
    Buffer.from(os.userInfo().username || ''),
    salt,
  ]);
  return crypto.createHash('sha256').update(material).digest();
}

export function sealInline(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION_TAG}:${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

export function unsealInline(sealed: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION_TAG) {
    throw new Error(`Invalid sealed blob: ${parts[0]}`);
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const key = deriveKey();
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
