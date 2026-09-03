/**
 * Types for @nova/account-client.
 *
 * HAND-WRITTEN, and deliberately so. The implementation is plain ESM with no build step —
 * that is what lets Online Earth load it straight into a page with no bundler at all — so
 * there is no compiler to emit these. Three of the four Nova products that use this package
 * are TypeScript, and a shared client they all have to `any`-cast is a shared client whose
 * contract nobody can see.
 *
 * Keep this in step with index.mjs. The types below are the contract; the doc comments there
 * are the reasoning.
 */

/** Every scope Nova Accounts defines. A product only ever receives what it is registered for. */
export type NovaScope = 'identity' | 'email' | 'support' | 'sync';

/**
 * An account, narrowed to what the token's scopes allow.
 *
 * `email` is OPTIONAL IN THE TYPE because it is optional in fact: a product that was not
 * granted the `email` scope never receives one, and the type is what stops a caller writing
 * `account.email` and finding out in production.
 */
export interface NovaAccount {
  id: string;
  displayName: string | null;
  /** Nova products this account has been used with. */
  products: string[];
  /** Present only when the `email` scope was granted. */
  email?: string;
  emailVerified?: boolean;
}

/** Somewhere to keep one token. See ./storage for the three that ship. */
export interface NovaTokenStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export type SignInFailure = 'expired' | 'denied' | 'cancelled' | 'unavailable' | 'refused';

/** A sign-in in progress. Returned immediately, so the UI can show the code at once. */
export interface NovaSignInFlow {
  ok: true;
  /** Show this to the person. */
  userCode: string;
  /** Tell them to go here. */
  verificationUri: string;
  /** Or open this for them — the same page with the code filled in. */
  verificationUriComplete: string;
  expiresAt: number;
  scopes: NovaScope[];
  /** Stop polling. `wait()` then resolves with `cancelled`. */
  cancel(): void;
  /** Poll until approved, refused, cancelled or expired. */
  wait(): Promise<
    { ok: true; account: NovaAccount; scopes: NovaScope[] } | { ok: false; reason: SignInFailure }
  >;
}

export type NovaRefreshResult =
  | { state: 'signed-in'; account: NovaAccount }
  /** The token is KEPT. A network failure is not a sign-out. */
  | { state: 'offline'; account: NovaAccount | null }
  | { state: 'signed-out' };

export type NovaPullResult =
  | { ok: true; version: number; data: unknown; updatedAt: string | null }
  | { ok: false; reason: 'signed-out' | 'no-scope' | 'offline'; offline?: boolean };

export type NovaPushResult =
  | { ok: true; version: number; updatedAt: string }
  /**
   * A conflict carries the server's document, because the only useful thing to do with one is
   * look at what you lost the race to. There is deliberately no way to force a write.
   */
  | { ok: false; reason: 'conflict'; current: { version: number; data: unknown; updatedAt: string | null } }
  | { ok: false; reason: 'signed-out' | 'no-scope' | 'offline' | 'too-large'; offline?: boolean };

export interface NovaAccountClient {
  readonly product: string;
  /** True when a token is held. No network call — safe to call on every render. */
  isSignedIn(): boolean;
  /** The last known account. No network call. */
  account(): NovaAccount | null;
  /** The scopes the held token actually carries, which may be narrower than what was asked. */
  scopes(): NovaScope[];
  refresh(): Promise<NovaRefreshResult>;
  beginSignIn(options?: { deviceName?: string | null }): Promise<NovaSignInFlow | { ok: false; reason: SignInFailure }>;
  signOut(): Promise<{ ok: true }>;
  pull(): Promise<NovaPullResult>;
  push(input: { baseVersion: number; data: unknown }): Promise<NovaPushResult>;
}

export interface NovaAccountClientOptions {
  /** A registered Nova product id, e.g. `open-cut`. */
  product: string;
  scopes?: NovaScope[];
  origin?: string;
  storage?: NovaTokenStorage;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

export declare const NOVA_ACCOUNTS_ORIGIN: string;
export declare const SIGN_IN_FAILURES: Readonly<Record<SignInFailure, string>>;

/** Forgets everything when the process ends. The default, so nothing is written unasked. */
export declare function memoryStorage(): NovaTokenStorage;

export declare function createNovaAccountClient(options: NovaAccountClientOptions): NovaAccountClient;
