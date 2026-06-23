import { KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICES } from './ref.js';

interface KeyringEntryLike {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntryLike;
}

let keyringModule: KeyringModule | null | undefined;

async function loadKeyring(): Promise<KeyringModule | null> {
  if (keyringModule !== undefined) return keyringModule;
  try {
    const importer = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
    const mod = await importer('@napi-rs/keyring');
    keyringModule = (mod as unknown as KeyringModule);
  } catch {
    keyringModule = null;
  }
  return keyringModule;
}

export function _resetKeychainCache(): void {
  keyringModule = undefined;
}

export async function isKeychainAvailable(): Promise<boolean> {
  return (await loadKeyring()) !== null;
}

export async function readKeychain(account: string): Promise<string | null> {
  const mod = await loadKeyring();
  if (!mod) throw new Error('OS keychain unavailable (install @napi-rs/keyring)');
  const readUnder = (service: string): string | null => {
    try {
      const entry = new mod.Entry(service, account);
      const value = entry.getPassword();
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch (e: any) {
      if (/NoEntry|no.such|not.found/i.test(e?.message || '')) return null;
      throw e;
    }
  };

  const current = readUnder(KEYCHAIN_SERVICE);
  if (current != null) return current;

  for (const legacy of LEGACY_KEYCHAIN_SERVICES) {
    const value = readUnder(legacy);
    if (value == null) continue;
    try {
      new mod.Entry(KEYCHAIN_SERVICE, account).setPassword(value);
    } catch {
    }
    return value;
  }
  return null;
}

export async function writeKeychain(account: string, value: string): Promise<void> {
  const mod = await loadKeyring();
  if (!mod) throw new Error('OS keychain unavailable (install @napi-rs/keyring)');
  const entry = new mod.Entry(KEYCHAIN_SERVICE, account);
  entry.setPassword(value);
}

export async function deleteKeychain(account: string): Promise<boolean> {
  const mod = await loadKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, account);
    return !!entry.deletePassword();
  } catch {
    return false;
  }
}
