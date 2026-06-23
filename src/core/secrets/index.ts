export type { CredentialRef } from './ref.js';
export { KEYCHAIN_SERVICE, isCredentialRef, describeCredentialRef } from './ref.js';
export { resolveCredential, tryResolveCredential, type ResolveOptions } from './resolver.js';
export {
  isKeychainAvailable, readKeychain, writeKeychain, deleteKeychain,
} from './store.js';
export { sealInline, unsealInline } from './inline-seal.js';

import { writeKeychain, deleteKeychain, isKeychainAvailable } from './store.js';
import { sealInline } from './inline-seal.js';
import type { CredentialRef } from './ref.js';

export async function persistSecret(account: string, plaintext: string): Promise<CredentialRef> {
  if (await isKeychainAvailable()) {
    try {
      await writeKeychain(account, plaintext);
      return { source: 'keychain', account };
    } catch {
    }
  }
  return { source: 'inline', sealed: sealInline(plaintext) };
}

export async function forgetSecret(ref: CredentialRef): Promise<void> {
  if (ref.source === 'keychain') {
    try { await deleteKeychain(ref.account); } catch {}
  }
}
