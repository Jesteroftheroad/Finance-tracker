# Finance Tracker

A small personal finance dashboard. Once a month you enter income, card balances, bank balances and your Wealthsimple balance. The app works out expense, savings and net worth for you. Data is stored in Supabase, so your phone, laptop and any other device all show the same numbers.

- Plain HTML/CSS/JS with no build step. Files: `index.html`, `style.css`, `calc.js` (the math), `app.js` (UI + sync), `config.js` (your keys).
- **Supabase** (free tier) holds the data and handles login. **GitHub Pages** (free) hosts the site.
- Your browser keeps a copy of the last synced data in localStorage. If you're offline, you still see your numbers. Saving needs a connection so devices never drift apart.

## The math

| | Formula |
|---|---|
| Total cards | sum of card balances |
| Total bank | sum of bank balances |
| Expense | `income − ((bank − cards) − (last month's bank − last month's cards))` |
| Savings | `income − expense` (= how much bank-minus-cards grew) |
| Net worth | `bank + Wealthsimple − cards` |

Wealthsimple is **never** part of expense or savings, so market swings can't change your spending number. It only appears in net worth and in its own trend line.

- The first month shows **n/a** for expense and savings, because there's no previous month to compare with.
- If you skip a month (e.g. July then September), September's expense covers both months. The table flags it with “after 1-month gap”.

---

## Setup (about 15 minutes)

### 1. Create the Supabase project
1. Go to <https://supabase.com>, sign up, then click **New project**.
2. Pick any name (e.g. `finance-tracker`), set a database password (save it somewhere), choose the region closest to you (e.g. *Canada (Central)*), and click **Create**. Wait about a minute for it to start.

### 2. Create the table
1. In your project, open **SQL Editor** → **New query**.
2. Paste the whole contents of [`schema.sql`](schema.sql) and click **Run**. You should see “Success. No rows returned”.

This creates one table, `months`, with Row Level Security turned on. Only your signed-in account can read or change its rows.

### 3. Create your login (one account, just you)
1. Go to **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter your email and a password, and tick **Auto Confirm User**. Click **Create user**.
3. Go to **Authentication** → **Sign In / Providers** (called *Providers* or *Settings* on some versions). Turn **off** “Allow new users to sign up”. After this, nobody else can create an account on your project.

### 4. Paste your keys
1. Go to **Project Settings** → **API** (or **API Keys**).
2. Copy the **Project URL** and the **anon / publishable** key. Do **not** use the `service_role` / secret key.
3. Open `config.js` and replace the two placeholder values:
   ```js
   SUPABASE_URL: "https://abcdxyz.supabase.co",
   SUPABASE_ANON_KEY: "eyJhbGciOi...",   // or sb_publishable_...
   ```
   You can commit this key to a public repo. It only lets someone *try* to log in, and Row Level Security blocks everything else.

### 5. Deploy on GitHub Pages
1. Commit and push `config.js` to this repo on the `main` branch (merge this branch into `main` first).
2. On GitHub, go to the repo → **Settings** → **Pages**.
3. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **`main`** and folder to **`/ (root)`**, then click **Save**.
4. After about a minute your site is live at `https://jesteroftheroad.github.io/finance-tracker/`. The exact URL is shown at the top of the Pages settings.

> GitHub Pages sites on a free account need a **public** repo. If you'd rather keep the repo private, use **Netlify** instead: sign in at <https://app.netlify.com> → **Add new site** → **Import an existing project** → pick this repo → leave the build command empty and set the publish directory to `/` → **Deploy**. Or drag the project folder onto <https://app.netlify.com/drop>.

### 6. Tell Supabase where the site lives (for magic links)
1. Go to **Authentication** → **URL Configuration**.
2. Set **Site URL** to your live URL, e.g. `https://jesteroftheroad.github.io/finance-tracker/`.
3. Add the same URL under **Redirect URLs**.

Password login works without this step. Magic links need it.

### 7. Put it on your phone's home screen
- **iPhone (Safari):** open the site → Share → **Add to Home Screen**.
- **Android (Chrome):** open the site → ⋮ menu → **Add to Home screen**.

It then opens full-screen like an app and stays signed in.

---

## Using it
- Tap **+ Month**. Your card and account names carry over from last month. Type this month's numbers, or tap **Copy last month's balances** and change only what moved.
- Add or remove cards and accounts with **+ Add card** / **✕**. Old months keep their own list, so history stays correct.
- The line under the form previews that month's expense, savings and net worth before you save.
- **Edit** / **Delete** are in the table. Deleting asks you to confirm first. The next month's expense is then recalculated against whichever month comes before it.
- **Export CSV** downloads everything as a spreadsheet backup.

## Free-tier note (keep Supabase from pausing)
Supabase pauses a free project after about a week with no activity. If you only open the dashboard once a month, it can go to sleep between entries. Your data is kept, and **Restore project** in the Supabase dashboard wakes it up.

To avoid this entirely, the included GitHub Action `.github/workflows/keep-supabase-awake.yml` pings the database twice a week. Turn it on by adding two secrets under repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
- `SUPABASE_URL`: same as in `config.js`
- `SUPABASE_ANON_KEY`: same as in `config.js`

To test it, go to the **Actions** tab → *Keep Supabase awake* → **Run workflow**.

## Running locally
Any static server works, for example `python3 -m http.server 8000`, then open <http://localhost:8000>. Add `http://localhost:8000` to Supabase's Redirect URLs if you want magic links to work locally.
