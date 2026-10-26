# Test site and live site

One code base, two Amplify branches, two completely separate sites (own database, sign-ins, storage, function):

| Branch | Site | What it does |
|---|---|---|
| `main` | **Test site** (orange TEST ribbon) | Always test: Zoho drafts only with TEST- numbers, Ziina test cards only, emails start with [TEST]. Whatever the SSM switches say. |
| `production` | **Live shop** | Real payments and real Zoho documents once `/kalai/zoho/test_mode` and `/kalai/ziina/test_mode` are `off`. |

Both use the same Zoho Books organisation, Ziina account and SSM parameters; only the live site obeys the test switches.

## How a change goes live
1. Every change is made on `main` and appears on the test site (Amplify builds it automatically).
2. Test it there.
3. Promote: merge `main` into `production` (ask Claude: "promote to production"). Amplify builds the live site.

## One-time set-up of the live site
1. Amplify console → app → **Hosting → Branches → Connect branch** → `production` (same repository). Wait for the first build.
2. **Secrets**: Amplify → Hosting → Secrets → make ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN apply to **all branches**
   (or add them for `production`). Redeploy `production` if the first build ran without them.
3. **Copy the data** (catalogue, artists and suppliers, offers, settings, pictures): AWS CloudShell →
   upload `scripts/copy-to-production.py` →
   `python3 copy-to-production.py` (dry run) → `python3 copy-to-production.py --go`.
   Real orders: add `--orders KA-…,KA-…`; customers: `--customers`; vouchers: `--vouchers`.
4. **Sign-ins**: accounts are not copied. Sign up on the live site with kalaiarthouse@pranixtechno.com, then Cognito →
   the production user pool → Groups → **ADMINS** → add yourself. Artists and suppliers sign up again with the same
   email: their profile, works, listings and jobs join the new account by themselves at the first sign-in.
5. **Domains** (Amplify → Hosting → Custom domains, pranixtechno.com): `art` → `production`,
   `test.art` (or similar) → `main`.
6. **Ziina webhook**: on the live site, Order Management → Pricing → Margin & charges → Online payments (Ziina) →
   register the webhook (it then points at the live site).
7. **Go live**: delete the test drafts in Zoho, then in CloudShell
   `aws ssm put-parameter --name /kalai/zoho/test_mode --type String --overwrite --value off` and the same for
   `/kalai/ziina/test_mode`. The test site stays in test mode regardless.
