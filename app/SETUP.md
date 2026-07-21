# Make CrashLabs a real GitHub App

This turns the check + PR comment from `github-actions[bot]` into **CrashLabs**,
with the CrashLabs logo — the way Greptile and Devin appear. ~3 minutes, then it
posts on demand with `node app/bot.mjs`.

## 1. Create the app (2 min, one browser page)

Go to **https://github.com/organizations/crashlabsai/settings/apps/new** and fill:

- **GitHub App name:** `CrashLabs`
- **Homepage URL:** `https://crashlabs.ai`
- **Webhook:** uncheck **Active** (we post on demand, no webhook needed)
- **Permissions → Repository:**
  - **Checks:** Read and write
  - **Pull requests:** Read and write
  - **Contents:** Read-only
- **Where can this app be installed?** Only on this account

Click **Create GitHub App**. Then:

- **Upload the logo:** on the app's page, "Display information" → upload
  `~/crashlabs-logo.png`.
- **App ID:** copy it from the top of the app's General page.
- **Private key:** scroll to "Private keys" → **Generate a private key** → a
  `.pem` downloads. Move it somewhere stable, e.g. `~/crashlabs-app.private-key.pem`.

> Prefer one click? The fields above are also in `app/app-manifest.json` — you can
> use GitHub's app-manifest flow, but the form above is faster for a one-off.

## 2. Install it on the repo (30 s)

App page → **Install App** → install on **crashlabsai** → select
**Only select repositories → kestrel-support** → Install.

## 3. Point the bot at your credentials

```bash
cd ~/Crashlabs/agent-check
cp app/.env.example app/.env
# edit app/.env: set CRASHLABS_APP_ID and CRASHLABS_APP_KEY to your .pem path
```

## 4. Post as CrashLabs

```bash
node app/bot.mjs --repo crashlabsai/kestrel-support --pr 1
```

This creates a **CrashLabs / behavioral** check run (red, with the full timeline
in its Details) and a PR comment — both authored by **CrashLabs**, with the logo.
Re-run it any time (after the green-fix commit it posts ✅ and unblocks).

## 5. Swap the merge gate + retire the Action

Once the app's check is posting:

```bash
# require the app's check instead of the Action's, and drop the Action
gh api --method PUT repos/crashlabsai/kestrel-support/branches/main/protection \
  --input - <<'JSON'
{ "required_status_checks": { "strict": false, "contexts": ["CrashLabs / behavioral", "lint & unit tests"] },
  "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null }
JSON
```

Then delete `.github/workflows/crashlabs.yml` from the Kestrel repo (a normal PR
or an admin push to main) so the only agent check is the CrashLabs app.

> Until you do step 5, the Actions-based check stays live so the demo always
> works. The app and the Action produce the same report; the app just posts it
> under the CrashLabs identity.
