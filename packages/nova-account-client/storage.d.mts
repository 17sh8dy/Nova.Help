/**
 * Types for @nova/account-client/storage -- the BROWSER-SAFE half.
 *
 * `fileStorage` is in ./nodeStorage.d.mts, because its implementation imports `node:fs` and a
 * renderer bundle must not be able to reach it. See storage.mjs.
 */
import type { NovaTokenStorage } from './index.mjs';

/** `localStorage`, for a page or an Electron renderer. Every call is guarded. */
export declare function browserStorage(key?: string): NovaTokenStorage;

/**
 * Anything with async get/set/remove -- the Tauri store plugin, or IPC to a main process.
 *
 * `prime()` fills the in-memory cache and must run before the first render; until it has, the
 * app is simply signed out, which is the right thing for an app that has not finished starting.
 */
export declare function asyncStorage(
  backend: {
    get(key: string): Promise<string | null | undefined>;
    set(key: string, value: string): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  },
  options?: { key?: string },
): NovaTokenStorage & { prime(): Promise<string | null> };
