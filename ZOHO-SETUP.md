# Zoho Books quote sync: setup

Every enquiry saved on the site (by a signed-in customer) creates a **quote** in Zoho Books
(organisation 941662167), always against one fixed customer: **Kalai Art House - Website**.
That customer is created automatically the first time if it doesn't exist.

Each quote has:
- **Reference#**: the website reference (e.g. KA-261020-AB12)
- **Item**: the artwork / commission / gift, with the details in the description
- **Rate**: AED 0 for price enquiries (you fill in the price), the website estimate for commissions,
  the total shown for Little Artists gifts
- **Customer notes**: the real customer's name, mobile and email

To use a different fixed customer name, change `ZOHO_CUSTOMER_NAME` in
`amplify/functions/zoho-quote-sync/resource.ts`.

Do the steps in this order. Step 3 must be done before step 4, or the Amplify build fails.

## 1. Create a Zoho "Self Client" (5 minutes)

1. Go to https://api-console.zoho.com and sign in with the Zoho account that owns Zoho Books.
2. **Add Client** → **Self Client** → **Create** → OK.
3. Copy the **Client ID** and **Client Secret** (Client Secret tab). Keep them private.
4. Open the **Generate Code** tab:
   - Scope: `ZohoBooks.estimates.CREATE,ZohoBooks.estimates.READ,ZohoBooks.estimates.UPDATE,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.UPDATE,ZohoBooks.customerpayments.CREATE,ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE`
   - Time duration: **10 minutes**
   - Description: `Kalai website quote sync`
   - **Create** → choose the Pranix Technologies organisation if asked → copy the **code**.

## 2. Turn the code into a refresh token (2 minutes, within 10 minutes of step 1.4)

AWS console → **CloudShell** (bottom left). Paste this, replacing the three values:

```
curl -s -X POST "https://accounts.zoho.com/oauth/v2/token?grant_type=authorization_code&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=CODE"
```

The reply contains `"refresh_token":"1000.xxxx…"`. Copy that value. If you see `invalid_code`, the code expired: generate a new one and run it again quickly.

## 3. Save three secrets in Amplify (3 minutes)

AWS Amplify → **kalai** → **Hosting** → **Secrets** → **Manage secrets** → add, for branch `main` (or all branches):

| Secret name | Value |
|---|---|
| `ZOHO_CLIENT_ID` | Client ID from step 1.3 |
| `ZOHO_CLIENT_SECRET` | Client Secret from step 1.3 |
| `ZOHO_REFRESH_TOKEN` | refresh_token from step 2 |

Save.

## 4. Upload the code to GitHub

1. On github.com/aniskeen-ui/kalai, open the **amplify** folder.
2. **+ / Add file → Upload files**.
3. From the unzipped `zoho-sync` folder, drag in `backend.ts` **and** the `functions` folder.
4. **Commit changes**. Amplify rebuilds (about 8–10 minutes).

## 5. Test

Sign in on art.pranixtechno.com and send an "Ask for price".
Within a minute a new quote appears in Zoho Books → **Sales → Quotes**, for customer
**Kalai Art House - Website**, with the KA- reference in **Reference#**.

If it doesn't: AWS console → **CloudWatch → Log groups** → the group containing `zoho-quote-sync` → latest log.
Send the error lines to Claude.

## Invoices, payments and the Paid lock

- Saving an enquiry as **Paid** in the Studio desk creates a Zoho invoice in the Kalai series **KAH-INV-0001, 0002…**, marks the quote Sent → Accepted and records the payment (Ziina/Card → Credit card, Bank → Bank transfer, Cash → Cash).
- Zoho's answer appears on the enquiry in the Studio desk (✓ Paid in Zoho / ✗ Zoho error, with the reason).
- Once the payment is in Zoho the enquiry is **locked**: the price can't change and the status can't go back to Received, Price sent or Cancelled.
- To undo a wrong or failed payment: in Zoho, delete the payment and/or void the invoice, then press **Check Zoho** in the Studio desk. It unlocks the enquiry and sets it back to Price sent. Marking it Paid again creates a fresh invoice (a voided one is never reused).

## Turning on VAT (after the TRN is issued)

Prices are VAT-inclusive. VAT stays off until you do this:

1. In Zoho Books: Settings → Taxes, set up UAE VAT with your TRN and a 5% standard-rate tax. Open it and copy the long number at the end of the browser address (the tax ID).
2. In AWS CloudShell (replace TAX_ID_HERE):

       aws ssm put-parameter --name /kalai/zoho/vat_tax_id --type String --overwrite --value TAX_ID_HERE

3. Within 10 minutes every new quote and invoice gets 5% VAT inside the price (AED 599 = 570.48 + 28.52 VAT). Existing invoices are not changed.

To switch VAT off again: same command with `--value off`.

## Purchase side: Siva Raja (order → bill → payment made)

This Zoho plan has no purchase orders, so Siva's order is kept on the Studio desk and Zoho gets the bill and the payment.

- **Siva prices the work** on the Artist desk (`/artist.html`): his price in INR, ready-by date and a note. He never sees customer names, numbers or your selling price.
- **You set the price** on the Studio desk: the Costing box converts his INR price with the master rates (Rates button) and suggests a selling price with your margin.
- **When the order is Paid**, Siva's order is recorded on the enquiry (his price is then fixed; he sees "Ordered").
- **His invoice arrives**: type his invoice number in "Siva's invoice no." and save. Zoho gets a **bill** from vendor "Siva Raja" for his price (AED) plus a line for the India courier he paid.
- **You pay him**: type your bank transfer reference in "Paid to Siva" and save. Zoho records a **payment made** against the bill.
- If Zoho asks for an expense account on the bill: Accountant → Chart of Accounts → open the account (e.g. Cost of Goods Sold) → copy the number at the end of the address, then in CloudShell:

      aws ssm put-parameter --name /kalai/zoho/artist_account_id --type String --overwrite --value ACCOUNT_ID

- **Check Zoho** on any enquiry lists every Zoho document for that order (quote, invoices, payments received, bills, payments made) with links.

### Zoho permissions needed (one new refresh token)

    ZohoBooks.estimates.CREATE,ZohoBooks.estimates.READ,ZohoBooks.estimates.UPDATE,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.UPDATE,ZohoBooks.customerpayments.CREATE,ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.purchaseorders.CREATE,ZohoBooks.purchaseorders.READ,ZohoBooks.purchaseorders.UPDATE,ZohoBooks.bills.CREATE,ZohoBooks.bills.READ,ZohoBooks.vendorpayments.CREATE

### Giving Siva access

1. Siva creates an account on art.pranixtechno.com (Sign in → Create account) with his email.
2. AWS console → Cognito → the user pool → Groups → **ARTISTS** → Add user → his email. (If his code email doesn't arrive, confirm him under Users → Actions → Confirm account, as you did for the admin.)
3. He signs in at **art.pranixtechno.com/artist.html**.

## Test mode (on until you switch it off)

While test mode is on, Zoho gets **drafts only**: the quote stays draft, the invoice is created as a draft (no payment recorded), and Siva's PO stays draft (no bill, no payment to him). The Studio desk shows "Test mode: drafts only" and nothing locks.

Go live (AWS CloudShell); takes effect within a minute:

    aws ssm put-parameter --name /kalai/zoho/test_mode --type String --overwrite --value off

Back to test mode: same command with `--value on`. Delete the test drafts in Zoho before going live.
