export type CredentialRef =
  | { source: 'keychain'; account: string }
  | { source: 'env';      varName: string }
  | { source: 'command';  argv: string[] }
  | { source: 'inline';   sealed: string };

export const KEYCHAIN_SERVICE = 'pikiloom';

export const LEGACY_KEYCHAIN_SERVICES = ['pikiclaw'];

export function isCredentialRef(value: unknown): value is CredentialRef {
  if (!value || typeof value !== 'object') return false;
  const r = value as { source?: unknown };
  switch (r.source) {
    case 'keychain': return typeof (value as any).account === 'string';
    case 'env':      return typeof (value as any).varName === 'string';
    case 'command':  return Array.isArray((value as any).argv);
    case 'inline':   return typeof (value as any).sealed === 'string';
    default: return false;
  }
}

export function describeCredentialRef(ref: CredentialRef): string {
  switch (ref.source) {
    case 'keychain': return `keychain:${ref.account}`;
    case 'env':      return `env:${ref.varName}`;
    case 'command':  return `cmd:${ref.argv[0] || '?'}…`;
    case 'inline':   return 'inline (sealed)';
  }
}
