# cf-email-web

Cloudflare Worker that:

- receives mail via `email(message, env, ctx)`
- optionally forwards incoming mail to one or more verified addresses
- stores mail bodies in R2 by default and keeps the inbox index in Workers KV
- shows stored mail in a password-protected web UI

## Files

- `src/index.js`: Worker code
- `wrangler.jsonc`: Cloudflare Worker config
- `.dev.vars.example`: local secret example

## Required secrets

Set secrets before deploy:

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
```

Optional plain variable:

```bash
wrangler secret put FORWARD_TO
```

`FORWARD_TO` accepts comma-separated destination emails, for example:

```text
you@example.com,backup@example.com
```

Optional variable:

```text
STORAGE_BACKEND=r2
```

Supported values:

- `r2`: default, full email JSON stored in R2, inbox index stored in KV
- `kv`: full email JSON stored in KV only

Important:

- Cloudflare Email Workers forwarding uses verified destination addresses.
- The configured account ID is `aa3bf2b79b8bbdbf05b4e289bd7c4d91`.
- `kv_namespaces` and `r2_buckets` are left without IDs/names so Wrangler can auto-provision them on deploy.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, then:

```bash
npm install
npm run dev
```

## Deploy

```bash
npm install
npm run deploy
```

## Cloudflare setup

After deploy, bind your Email Worker to an Email Routing custom address in the Cloudflare dashboard:

1. Open `Email Routing`
2. Create or edit a route
3. Set destination to this Worker
4. Send a test mail to that custom address

## Notes

- The web UI stores only the latest 200 emails in the KV index.
- With the default `r2` backend, full email records remain in R2 for later review even after coworkers change.
- Raw MIME is stored as a preview string capped at about 300 KB per email for safer viewing.
- MIME parsing is intentionally simple. Plain text and HTML extraction work best for common emails, not every complex multipart case.
