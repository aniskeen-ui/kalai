# Kalai Art House: setup guide

This project is the Kalai Art House website plus:

- **Customer accounts:** sign up with email and password, confirmed by a code sent by email.
- **My enquiries:** customers see each price enquiry, commission and Little Artists gift with its status, your price, your message and a Pay now button.
- **Studio desk** (`/admin.html`): you see every enquiry, open uploaded photos, and set the price, payment link, status and message.
- **Private uploads:** reference photos and children's drawings, readable only by the customer and by admins.

Everything runs in your AWS account through AWS Amplify. Your current site (`kalai-art`, manual upload) stays live until step 4.

---

## 1. Put the code on GitHub (about 10 minutes)

1. Create a free account at **github.com** if you don't have one.
2. Click **+ → New repository**. Name it `kalai-art-house`, choose **Private**, and click **Create repository**.
3. On the empty repository page, click **uploading an existing file**.
4. Unzip `kalai-amplify.zip` on your computer. Open the unzipped folder, select **everything inside it** (`amplify`, `src`, `index.html`, `admin.html`, `package.json`, `amplify.yml`, `vite.config.js`, `SETUP.md`, `.gitignore`), and drag it onto the GitHub page.
   - The `amplify` and `src` folders must stay as folders. GitHub keeps them when you drag them in.
   - `.gitignore` is hidden on some computers. It's fine if it doesn't upload.
5. Click **Commit changes**.

## 2. Create the new Amplify app from GitHub (about 15 minutes, mostly waiting)

1. AWS console → **AWS Amplify** → **Create new app** → **GitHub** → **Next**.
2. Allow AWS Amplify to access your GitHub account, then pick the `kalai-art-house` repository and the `main` branch → **Next**.
3. App name: `kalai-art-house`. Amplify detects the `amplify.yml` build settings. Leave them as they are.
4. Under **Service role**, choose **Create and use a new service role**.
5. **Save and deploy**. The first build takes about 8–15 minutes because it creates the login system, database and storage.
6. When the build is green, open the `https://main.xxxx.amplifyapp.com` link and check the site loads.

If the build fails, open the failed step, copy the last 30 lines of the log and send them to Claude.

## 3. Make yourself an admin (5 minutes)

1. On the new site, tap **Sign in → Create an account**, using `kalaiarthouse@pranixtechno.com` or your own email. Enter the 6-digit code from the email.
2. AWS console → **Amplify** → `kalai-art-house` → **Authentication** in the left menu (or search **Cognito** → **User pools** → the pool whose name contains `amplifyAuthUserPool`).
3. Open **Groups** → **ADMINS** → **Add user to group** → choose your email → **Add**.
4. Go to `https://main.xxxx.amplifyapp.com/admin.html`, sign in with the same email and password, and you'll see the Studio desk.

## 4. Move art.pranixtechno.com to the new app (10 minutes)

1. Old app `kalai-art` → **Hosting → Custom domains** → open `pranixtechno.com` → **Remove domain**. The address stops working for a few minutes.
2. New app `kalai-art-house` → **Hosting → Custom domains** → **Add domain** → `pranixtechno.com`.
3. Click **Exclude root**, then set the subdomain to **`art`** → branch **`main`**. Leave the redirect box unticked. Save.
4. Wait for **Available** (up to 30 minutes). DNS is in Route 53, so it updates automatically.
5. Once `https://art.pranixtechno.com` shows the new site (with **Sign in** in the header), delete the old `kalai-art` app.

## 5. Auto-delete uploads after 60 days (3 minutes)

The website promises that uploaded drawings and photos are deleted after 60 days.

1. AWS console → **S3** → open the bucket whose name contains `kalaiuploads`.
2. **Management** tab → **Create lifecycle rule**.
3. Name: `delete-uploads-after-60-days`. Choose **Limit the scope… using filters**, prefix `uploads/`.
4. Tick **Expire current versions of objects**, enter **60** days → **Create rule**.

---

## Daily use

- **New enquiry:** WhatsApp still opens with the reference number (for example `KA-261019-7U05`), so you're notified on your phone as before. If the customer was signed in, it's also on the Studio desk.
- **Reply with a price:** Studio desk → click the enquiry → set **Status: Price sent**, the **Price**, a **Payment link** from Telr, Tap or Stripe, and a short message → **Save**. Then tap **Send update on WhatsApp** to tell the customer.
- **Move it along:** set Paid → Being framed → Shipped → Delivered as it happens. The customer sees each step under My enquiries.
- **Change the website:** edit a file on GitHub (or ask Claude for an updated file and upload it there). Amplify rebuilds and publishes automatically in a few minutes.

## Good to know

- **Verification emails** are sent by Amazon Cognito's built-in mailer, from a no-reply AWS address, with a limit of about 50 emails a day. That's enough to start. To send from your own address or send more, set up Amazon SES later and connect it to the user pool.
- **Guests** can still use every form without an account. Their enquiry goes to WhatsApp only and doesn't appear on the Studio desk.
- **Costs:** at your volume, Cognito, the database (DynamoDB), S3 and Amplify hosting usually come to a few US dollars a month or less. Keep the budget alert on.
- **Customer passwords** are stored by Amazon Cognito. Neither you nor this code can see them.
