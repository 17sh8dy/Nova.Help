# Nova.Help

The support portal for the Nova ecosystem — and the place a Nova Account is signed in to.

Zero runtime dependencies. Node ≥20, ESM, no framework and no build step.

```
npm start      # port 4400
npm test       # 624 tests
npm run check  # validate the support catalog and the product directory, without booting
```

## What is in here

| | |
|---|---|
| `data/` | The support catalog (6 products, 41 areas, 139 issue types) and `ecosystem.js`, the product directory. Edited by people who are not editing the server; `npm run check` is their gate. |
| `server/` | `core/` decides, `lib/` is HTTP plumbing, `views/` renders HTML strings, `store/` is the storage seam. |
| `packages/nova-accounts` | **Nova Accounts.** The identity system for the whole ecosystem. Shared with the Nova site, which binds the same database. |
| `packages/nova-account-client` | What an *installed* Nova product uses to sign somebody in. Shared with Open Cut, Online Earth, Replay.GG and Atlas. |

## Accounts

**Read before touching sign-in anywhere in Nova.**

- [`docs/NOVA-ACCOUNTS.md`](docs/NOVA-ACCOUNTS.md) — the account model, passwords, sessions,
  federated sign-in, and **the access rule that is easiest to get wrong** (§4).
- [`docs/NOVA-IDENTITY.md`](docs/NOVA-IDENTITY.md) — one account, two web front doors, one
  database.
- [`docs/NOVA-PRODUCTS.md`](docs/NOVA-PRODUCTS.md) — how the four installed products sign in
  (the device grant), scopes, sync, and how to add the next product.

The rule that binds all of it:

> **A Nova Account connects the ecosystem; it does not gate it.** Every Nova product works
> without one, the guest path through this portal is complete and unblocked, and no feature may
> start checking whether somebody is signed in.
