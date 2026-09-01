/**
 * What a Nova Account may be created with.
 *
 * The rules live in the accounts module rather than in a Nova.Help form so that every product
 * that later signs people in gets the same answer to "is this a usable password" — a rule that
 * exists in one product's controller is a rule the next product reimplements slightly
 * differently.
 *
 * THE PASSWORD RULE IS LENGTH, NOT COMPOSITION. A required symbol and a required digit push
 * people towards `Password1!` and no further; length is the only requirement that reliably
 * buys entropy, so the floor is 10 characters and the ceiling is high enough that a
 * passphrase or a password manager's output fits. The only things refused outright are the
 * handful of strings that are guessed first, and a password that is simply the address it
 * protects.
 */
export const ACCOUNT_LIMITS = {
  email: { max: 254 },
  password: { min: 10, max: 256 },
  displayName: { max: 80 },
};

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const collapse = (value) => str(value).replace(/\s+/g, ' ');

/** The canonical form an address is stored and compared in. */
export const normalizeEmail = (value) => str(value).toLowerCase();

export const isEmail = (value) => EMAIL.test(str(value)) && str(value).length <= ACCOUNT_LIMITS.email.max;

/**
 * The passwords tried first by anything that tries passwords at all. This is a speed bump on
 * the worst choices, not a strength meter — the length floor is what does the real work.
 */
const OBVIOUS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '1234567890', '12345678901',
  '123456789', 'qwertyuiop', 'letmein123', 'iloveyou12', 'welcome123', 'admin12345',
  'novaaccount', 'novaaccount1', 'changeme123', 'trustno1234', 'football12', 'baseball12',
]);

/**
 * Validate a sign-up. Returns `{ ok, values, errors }`; `values` is always populated so the
 * form can be re-rendered with what was typed — minus the password, which is never echoed
 * back into a page.
 */
export function validateRegistration(input = {}) {
  const errors = {};
  const values = {
    email: normalizeEmail(input.email),
    displayName: collapse(input.displayName),
  };
  const password = typeof input.password === 'string' ? input.password : '';
  const confirm = typeof input.passwordConfirm === 'string' ? input.passwordConfirm : '';

  if (!values.email) errors.email = 'Enter the email address you want on the account.';
  else if (!isEmail(values.email)) errors.email = 'That does not look like an email address.';

  if (values.displayName.length > ACCOUNT_LIMITS.displayName.max) {
    errors.displayName = `Please keep it under ${ACCOUNT_LIMITS.displayName.max} characters.`;
  }

  if (!password) errors.password = 'Choose a password.';
  else if (password.length < ACCOUNT_LIMITS.password.min)
    errors.password = `Use at least ${ACCOUNT_LIMITS.password.min} characters. A short sentence works well.`;
  else if (password.length > ACCOUNT_LIMITS.password.max)
    errors.password = `That is longer than ${ACCOUNT_LIMITS.password.max} characters.`;
  else if (OBVIOUS.has(password.toLowerCase()))
    errors.password = 'That password is one of the first anybody guesses. Please pick another.';
  else if (values.email && password.toLowerCase() === values.email)
    errors.password = 'Your password cannot be your email address.';

  if (!errors.password && confirm !== password) {
    errors.passwordConfirm = 'The two passwords do not match.';
  }

  return { ok: Object.keys(errors).length === 0, values, errors, password };
}

/**
 * Validate a "I have forgotten my password" request.
 *
 * ONLY THE SHAPE OF THE ADDRESS IS CHECKED, and that is the design. Whether an account exists
 * is never decided here and never reaches the page: the route answers identically for an
 * address that has an account and one that does not, so this form cannot be walked through a
 * list to learn who has signed up. See `requestPasswordReset` in service.mjs.
 */
export function validateResetRequest(input = {}) {
  const errors = {};
  const values = { email: normalizeEmail(input.email) };

  if (!values.email) errors.email = 'Enter your email address.';
  else if (!isEmail(values.email)) errors.email = 'That does not look like an email address.';

  return { ok: Object.keys(errors).length === 0, values, errors };
}

/**
 * Validate a new password chosen through a reset link.
 *
 * The rules are the sign-up rules, deliberately. A password chosen at the end of a reset is not
 * a lesser password, and keeping two sets of rules is how the weaker one ends up governing the
 * flow an attacker actually uses. The address is passed in rather than typed, so that "your
 * password cannot be your email address" still holds on a form that never asks for it.
 */
export function validatePasswordReset(input = {}, { email = '' } = {}) {
  const errors = {};
  const password = typeof input.password === 'string' ? input.password : '';
  const confirm = typeof input.passwordConfirm === 'string' ? input.passwordConfirm : '';
  const address = normalizeEmail(email);

  if (!password) errors.password = 'Choose a new password.';
  else if (password.length < ACCOUNT_LIMITS.password.min)
    errors.password = `Use at least ${ACCOUNT_LIMITS.password.min} characters. A short sentence works well.`;
  else if (password.length > ACCOUNT_LIMITS.password.max)
    errors.password = `That is longer than ${ACCOUNT_LIMITS.password.max} characters.`;
  else if (OBVIOUS.has(password.toLowerCase()))
    errors.password = 'That password is one of the first anybody guesses. Please pick another.';
  else if (address && password.toLowerCase() === address)
    errors.password = 'Your password cannot be your email address.';

  if (!errors.password && confirm !== password) {
    errors.passwordConfirm = 'The two passwords do not match.';
  }

  return { ok: Object.keys(errors).length === 0, errors, password };
}

/**
 * Validate a sign-in attempt.
 *
 * Only shape is checked here — whether the address exists and whether the password is right is
 * decided by the service, in one answer, so that this function cannot become an oracle.
 */
export function validateSignIn(input = {}) {
  const errors = {};
  const values = { email: normalizeEmail(input.email) };
  const password = typeof input.password === 'string' ? input.password : '';

  if (!values.email) errors.email = 'Enter your email address.';
  else if (!isEmail(values.email)) errors.email = 'That does not look like an email address.';
  if (!password) errors.password = 'Enter your password.';

  return { ok: Object.keys(errors).length === 0, values, errors, password };
}
