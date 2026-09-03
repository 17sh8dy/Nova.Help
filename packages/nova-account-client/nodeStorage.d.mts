/**
 * Types for @nova/account-client/storage/node. See index.d.mts for why these are hand-written.
 */
import type { NovaTokenStorage } from './index.mjs';

/** A 0600 file in a directory the app owns. For Electron main, or any Node host. */
export declare function fileStorage(
  directory: string,
  options?: { filename?: string },
): NovaTokenStorage;
