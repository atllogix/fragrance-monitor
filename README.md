# Fragrance Monitor Setup

This checks 5 fragrance discounter sites every ~5 minutes, forever, for free,
even when your computer is off — and sends a push notification to your phone
for new arrivals, restocks, and price drops.

## Step 1: Set up push notifications (ntfy.sh) — 2 minutes

1. On your phone, install the app **ntfy** (search your app store — it's free,
   made by ntfy.sh, no account required).
2. Open the app and tap **Subscribe to topic**.
3. Pick a topic name only you would guess — something like
   `jomashop-alerts-8f2k1` (add random characters so a stranger can't guess it
   and send you fake alerts). Write this exact name down, you'll need it in Step 3.
4. That's it — the app is now listening for that topic name.

## Step 2: Create a free GitHub account and repository — 3 minutes

1. Go to github.com and sign up (free) if you don't have an account.
2. Click the **+** in the top right → **New repository**.
3. Name it anything, e.g. `fragrance-monitor`.
4. Set it to **Public** (this is important — public repos get unlimited free
   automation minutes; private repos have a limited monthly quota that this
   would exceed). The data involved (product names/prices) is all public
   storefront info anyway, nothing sensitive.
5. Click **Create repository**.

## Step 3: Add your ntfy topic as a secret — 1 minute

1. In your new repo, click **Settings** (top menu of the repo, not your
   account settings).
2. In the left sidebar: **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. Name: `NTFY_TOPIC`
5. Value: the topic name you picked in Step 1 (e.g. `jomashop-alerts-8f2k1`).
6. Click **Add secret**.

## Step 4: Allow the automation to save its own progress — 1 minute

1. Still in **Settings** → left sidebar → **Actions** → **General**.
2. Scroll to **Workflow permissions**.
3. Select **Read and write permissions**.
4. Click **Save**.

## Step 5: Upload the two files

1. Back on the repo's main page, click **Add file** → **Upload files**.
2. Upload `monitor.js` so it sits at the root of the repo.
3. Upload the `.github/workflows/monitor.yml` file — when uploading, make
   sure it lands in that exact folder path (GitHub will let you drag the
   whole folder, or you can create the path manually: click **Add file** →
   **Create new file**, type `.github/workflows/monitor.yml` as the filename,
   which auto-creates the folders, then paste the file's contents in).
4. Commit both.

## Step 6: Run it for the first time

1. Click the **Actions** tab at the top of your repo.
2. Click **Fragrance Monitor** in the left sidebar.
3. Click **Run workflow** (top right) → **Run workflow** again to confirm.
4. Wait ~1 minute, refresh — you should see a green checkmark.

This first run just builds a baseline (no alerts yet, on purpose — otherwise
you'd get one notification per product). From here on, it runs automatically
every 5 minutes, forever, with no computer or app needing to stay open.

## Notes

- GitHub's scheduler can occasionally lag a few minutes during high load —
  so "every 5 minutes" is closer to "every 5-10 minutes" in practice. Still
  far better than checking manually.
- If you ever want to check it's alive: **Actions** tab shows a log of every
  run and whether it succeeded.
- If a site changes its layout and stops working, that run will show a red X
  in the Actions tab — check the log for which site failed.
