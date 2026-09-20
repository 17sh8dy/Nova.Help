/* Scripted page states for NovaI18n's extractor (../NovaI18n): the error and confirmation text a
   crawl by link-following can never see. Kept outside public/ so it is never deployed. */
const submit = (page, form = 'form') => page.locator(`${form} button[type=submit]`).first().click();
const loosen = (page) => page.evaluate(() => document.querySelectorAll('[required],[maxlength],[minlength],[pattern]').forEach((e) => { e.removeAttribute('required'); e.removeAttribute('pattern'); if (e.type === 'email') e.type = 'text'; }));

export default [
  { name: 'sign-in: wrong password', run: async (page, base) => {
    await page.goto(base + '/account/sign-in');
    await page.fill('#email', 'nobody@example.com'); await page.fill('#password', 'not-the-password'); await submit(page);
  } },
  { name: 'sign-in: empty', run: async (page, base) => { await page.goto(base + '/account/sign-in'); await loosen(page); await submit(page); } },
  { name: 'create: invalid', run: async (page, base) => {
    await page.goto(base + '/account/new'); await loosen(page);
    await page.fill('#email', 'not-an-email'); await page.fill('#password', 'short'); await page.fill('#passwordConfirm', 'different'); await submit(page);
  } },
  { name: 'forgot: sent', run: async (page, base) => { await page.goto(base + '/account/forgot'); await page.fill('#email', 'someone@example.com'); await submit(page); } },
  { name: 'reset: dead link', run: async (page, base) => { await page.goto(base + '/account/reset?token=not-a-real-token'); } },
  { name: 'ticket form: empty submit', run: async (page, base) => {
    await page.goto(base + '/help/atlas/install');
    await page.locator('a[href^="/help/atlas/install/"]').first().click();
    await loosen(page);
    await submit(page, 'form[action="/tickets"]');
  } },
  { name: 'ticket lookup', run: async (page, base) => { await page.goto(base + '/tickets'); await loosen(page); await submit(page); } },
  { name: 'not found', run: async (page, base) => { await page.goto(base + '/no-such-page'); } },
];
