/**
 * Nova Accounts — the shared identity foundation for the Nova ecosystem.
 *
 * ONE CALL BUILDS THE WHOLE THING:
 *
 *     const accounts = await createAccounts({ dir, secret });
 *     await accounts.register({ email, password, passwordConfirm });
 *     await accounts.signIn({ email, password });
 *     await accounts.resolveSession(tokenFromCookie);
 *
 * WHAT THIS MODULE IS FOR. Nova.Help is the first Nova product to sign people in, and it will
 * not be the last. The long-term intent — written down in docs/NOVA-ACCOUNTS.md — is one Nova
 * Account that works across Nova.Help, the Launcher, the Store, Online Earth, Atlas, Open Cut,
 * Nova Engine and Replay.GG, rather than eight products each growing their own login. So the
 * code that decides what an account is lives in this directory, behind this one entry point,
 * and obeys one rule:
 *
 *     NOTHING UNDER server/accounts/ MAY IMPORT FROM ANYWHERE ELSE IN THIS REPOSITORY.
 *
 * That is the whole discipline. It keeps the module liftable: when Nova Accounts becomes a
 * service other products call over HTTP, this directory moves out as a package and Nova.Help
 * keeps talking to the same five methods — the only change is that `store` is backed by a
 * database and `createAccounts` by a network client. A single import of a Nova.Help ticket
 * type in here would turn that move into a rewrite, which is exactly how shared identity
 * systems fail to happen.
 *
 * KEY SEPARATION. The session signing key is derived from the application secret rather than
 * being the application secret, so a Nova.Help ticket pass and a Nova Account session are
 * signed under different keys even though the deployment configures only one. The OAuth state
 * envelope gets a third, derived the same way. Changing the application secret invalidates all
 * of them, which is the behaviour you want from a key rotation.
 *
 * FEDERATED SIGN-IN LIVES UNDER providers/ AND IS OPTIONAL. Pass `providers: []` — or pass
 * nothing, which is what an unconfigured deployment does — and Nova Accounts is exactly what
 * it was before: email and password. Nothing about the account model changes when a provider
 * is added, which is the property that lets Apple or Discord arrive later as configuration
 * rather than as a migration.
 */
import { createHmac } from 'node:crypto';

import { createAccountStore } from './store.mjs';
import { createAccountService, publicView } from './service.mjs';
import { createSessionTokens, SESSION_COOKIE, SESSION_TTL_SECONDS } from './sessions.mjs';
import { createResetTokens, RESET_TTL_SECONDS } from './resetTokens.mjs';
import { createNullMailer } from './mail.mjs';
import { DEFAULT_COST } from './passwords.mjs';
import { ACCOUNT_LIMITS, normalizeEmail } from './validation.mjs';
import { createProviderRegistry, OAUTH_COOKIE, OAUTH_TTL_SECONDS } from './providers/index.mjs';
import { createProductTokens, deriveProductSecret, PRODUCT_TOKEN_TTL_SECONDS } from './productTokens.mjs';
import { createDeviceService, scopedView } from './deviceService.mjs';
import { createSyncService } from './syncDocuments.mjs';

export { SESSION_COOKIE, SESSION_TTL_SECONDS, ACCOUNT_LIMITS, DEFAULT_COST, publicView, normalizeEmail };
export { RESET_TTL_SECONDS };
export { createLogMailer, createMemoryMailer, createNullMailer } from './mail.mjs';
export { OAUTH_COOKIE, OAUTH_TTL_SECONDS };
export { createGoogleProvider } from './providers/google.mjs';
export { createOidcProvider } from './providers/oidc.mjs';

/* The ecosystem seam, exported so a front door can render the product list, and a product can
   ask what it is allowed, without either one restating the registry. */
export { PRODUCTS, SCOPES, IMPLIED_SCOPES, getProduct, isProduct, grantableScopes } from './products.mjs';
export { bearerToken, PRODUCT_TOKEN_TTL_SECONDS } from './productTokens.mjs';
export {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  isUserCode,
  normalizeUserCode,
} from './deviceCodes.mjs';
export { scopedView };
export { SYNC_DOCUMENT_LIMIT, encodeSyncDocument, decodeSyncDocument } from './syncDocuments.mjs';

/** Derive the account-session key from the application secret. Domain-separated, one-way. */
export const deriveSessionSecret = (secret) =>
  createHmac('sha256', String(secret)).update('nova.accounts.session.v1').digest('hex');

export { deriveProductSecret };

/**
 * Build the account service over a data directory.
 *
 * `cost` is the scrypt setting; it exists as a parameter so a test suite can run cheaply
 * without the production default being anything other than the production default.
 */
export async function createAccounts({
  dir,
  secret,
  cost = DEFAULT_COST,
  product = 'nova.help',
  ttlSeconds = SESSION_TTL_SECONDS,
  providers = [],
  /**
   * How reset mail leaves the building: `{ send({ to, subject, text }) }`.
   *
   * Injected, never imported, for the same reason the store is — which transport a deployment
   * has is not this module's business. Left unset it is the null transport, which sends
   * nothing and says so loudly every time, because a password reset that silently goes nowhere
   * is worse than one that is obviously not configured. See mail.mjs.
   */
  mailer = null,
  /** How long a reset link lives. */
  resetTtlSeconds = RESET_TTL_SECONDS,
  /** The name that appears in reset mail, and where to send somebody who needs help with it. */
  productName = 'Nova',
  supportUrl = null,
  logger = console,
  /**
   * A store to use instead of the JSON one — accounts/d1Store.mjs, or whatever comes after it.
   *
   * It is INJECTED rather than selected here, and that is the rule at the top of this file
   * doing its job: a `kind === 'd1'` switch in this function would be Nova Accounts holding an
   * opinion about one deployment's infrastructure, and the day this directory lifts out as a
   * package that opinion is exactly what would have to be unpicked. The caller knows which
   * database it has; this module only needs a store.
   */
  store: injectedStore = null,
  /**
   * How long a product token lives, and where a person is sent to approve one.
   *
   * `verificationUri` is INJECTED because Nova Accounts does not know which host it is being
   * served from — the same reason `mailer` and `store` are. Left null, the device flow still
   * works and simply cannot tell the app where to send somebody, which is a client-side
   * inconvenience rather than a security question.
   */
  productTokenTtlSeconds = PRODUCT_TOKEN_TTL_SECONDS,
  deviceVerificationUri = null,
} = {}) {
  const store = injectedStore ?? createAccountStore({ dir });
  const loaded = await store.init();

  const tokens = createSessionTokens({ secret: deriveSessionSecret(secret), ttlSeconds });
  const resetTokens = createResetTokens({ ttlSeconds: resetTtlSeconds });
  const transport = mailer ?? createNullMailer({ logger });
  const service = createAccountService({
    store,
    tokens,
    cost,
    product,
    resetTokens,
    mailer: transport,
    productName,
    supportUrl,
    logger,
  });
  const registry = createProviderRegistry({ providers, secret });

  /* A THIRD derived key, alongside the session key and the OAuth state key. A product token
     and a web session are therefore different strings even for the same account and session
     shape, which is what stops one being replayed as the other. See productTokens.mjs. */
  const productTokens = createProductTokens({
    secret: deriveProductSecret(secret),
    ttlSeconds: productTokenTtlSeconds,
  });

  const devices = createDeviceService({
    store,
    productTokens,
    verificationUri: deviceVerificationUri,
    logger,
  });

  const sync = createSyncService({ store });

  return {
    ...service,
    ...devices,
    ...sync,
    store,
    tokens,
    productTokens,
    resetTokens,
    mailer: transport,
    providers: registry,
    devices,
    sync,
    loaded,
    ttlSeconds,
    resetTtlSeconds,
  };
}
