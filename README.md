# Mail (Stalwart)

Self-hosted mail server on [Stalwart](https://github.com/stalwartlabs/mail-server) (v0.16),
managed through `stalwart.sh`:
- Create/delete domains & mailboxes: calls [`stalwart-cli`](https://stalw.art/docs/management/cli)
  (as of v0.16, Stalwart dropped the old `/api/...` REST API — all admin operations now go through
  the CLI/JMAP).
- Read email, get ACCOUNT_ID/INBOX_ID: plain JMAP via `curl`/`jq`, unchanged.
- Receiving email from the Internet: the host running Stalwart is on a private network with no
  public ports, so it uses Cloudflare Email Routing + a Worker to push mail into Stalwart via
  JMAP — see [Receiving email from outside](#receiving-email-from-outside-cloudflare-email-routing)
  below.
- Managing + reading mail over the web: `admin-app/` — a single-page console, one admin login,
  create/delete domains & mailboxes and read every mailbox's mail without a separate password
  per mailbox — see [Admin console (admin-app)](#admin-console-admin-app) below.
- Reading mail from a phone: `webmail/index.html` — a single static HTML page, no backend, each
  mailbox logs in with its own email/password — see
  [Webmail (phone-friendly reader)](#webmail-phone-friendly-reader) below.

## First-time setup (cloning onto a new machine)

```bash
cp .env.example .env
```

Fill in `MAIL_DOMAIN`, `ADMIN_PASSWORD`, `CLOUDFLARE_TUNNEL_TOKEN` (Cloudflare Zero Trust dashboard
→ Networks → Tunnels → the tunnel in use → Configure → token), and `APP_ADMIN_PASSWORD` in `.env`
— this file is not tracked by git (`.gitignore`), so real values are never committed.

### Where the domain comes from

`MAIL_DOMAIN` in `.env` (e.g. `example.com`) is the single source of truth for your domain. The
server's own hostname is always `mail.$MAIL_DOMAIN` by convention. These read it automatically —
no file needs manual editing for the domain:

- `docker-compose.yml` — the `stalwart` container's `hostname`
- `stalwart.sh` / `admin-app` — never hardcode a domain; they talk to Stalwart over
  `STALWART_API`/`STALWART_URL` (default `http://127.0.0.1:8080` or the internal `stalwart:8080`
  Docker service name), so they don't need `MAIL_DOMAIN` at all
- `email-worker/setup.sh` — reads `MAIL_DOMAIN` and passes `https://mail.$MAIL_DOMAIN` to the
  Worker at deploy time (`wrangler deploy --var STALWART_URL:...`)
- `webmail/index.html` — this one has no backend at all (it's a static page), so it can't read
  `.env`; instead it derives the hostname from whatever email address you log in with (e.g.
  logging in as `hello@example.com` talks to `https://mail.example.com`)

The **only** places that still require a manual, one-time entry (because they live in the
Cloudflare dashboard, not a file) are called out explicitly where they come up below:
Email Worker "Option 2" deploy, and exposing `admin-app` via cloudflared.

## Requirements

- `docker compose` is running the `stalwart` service (see `docker-compose.yml`) and the first-time
  setup wizard has been completed (log in at `https://mail.$MAIL_DOMAIN`, go through every step and
  click Finish/Save)
- `curl`, `jq`, `openssl` installed
- `stalwart-cli` installed:

  ```bash
  curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/stalwartlabs/cli/releases/latest/download/stalwart-cli-installer.sh | sh
  ```

- `.env` contains `ADMIN_PASSWORD` — must match the password used to log into the setup wizard
  (if you change `.env` after the container was created, run
  `docker compose up -d --force-recreate stalwart` so the container picks up the new value)

## Create a domain

Run once per domain:

```bash
./stalwart.sh domain example.com
```

## Create a mailbox (email account)

```bash
./stalwart.sh user user@example.com                      # auto-generate a password
./stalwart.sh user user@example.com 'MyPassword123!'      # choose your own password
./stalwart.sh user user@example.com 'MyPassword123!' 1024 # + 1024 MB quota
```

The script prints the email / username / password — save it now, it won't be shown again.

## List / delete accounts

```bash
./stalwart.sh list
./stalwart.sh delete user@example.com
```

## Get ACCOUNT_ID / INBOX_ID

For configuring another app/Worker that integrates via JMAP:

```bash
./stalwart.sh info user@example.com 'MyPassword123!'
```

## Read incoming email (INBOX)

```bash
./stalwart.sh read user@example.com 'MyPassword123!'      # 10 most recent emails
./stalwart.sh read user@example.com 'MyPassword123!' 30    # 30 most recent emails
```

Each email prints a block with status (`NEW` / `read`), received time, sender, subject, and the
full body text. This command uses JMAP (`Email/query` + `Email/get`) over port `8080` — no IMAP
port needed (`docker-compose.yml` currently publishes only port `8080` to the host).

## Receiving email from outside (Cloudflare Email Routing)

### Why direct SMTP delivery doesn't work here

The host running Stalwart is on a private network, with **no public ports at all** (including
port 25/SMTP). For an outside MTA (Gmail, Outlook...) to deliver mail directly, the domain needs
an MX record pointing at a public IP with port 25 open — a condition that can't be met through
software configuration or Cloudflare Tunnel (the tunnel only forwards HTTP(S), not raw SMTP).

### Solution: Cloudflare Email Routing → Worker → JMAP

Your domain (`$MAIL_DOMAIN`) uses Cloudflare as its nameserver, so **Cloudflare Email Routing**
can be enabled (free): Cloudflare receives SMTP on the server's behalf (no port needed locally),
then invokes a **Cloudflare Worker** to process each message. This worker
(`email-worker/src/index.js`) pushes the mail content into the right Stalwart mailbox via JMAP,
going through the same HTTPS endpoint `https://mail.$MAIL_DOMAIN` already served by the
cloudflared tunnel — no extra port needed:

1. Log into JMAP as `admin` (session + `Principal/query` filtered by the recipient's email) to
   find the target mailbox's `accountId`.
2. Upload the raw mail content (RFC822) as a blob in that account.
3. `Mailbox/query` to find that account's Inbox.
4. `Email/import` the blob into the Inbox.

Thanks to the **catch-all rule**, every mailbox created with `./stalwart.sh user ...` starts
receiving mail immediately, with no need to touch the Cloudflare config again.

**Limitation:** `Email/import` inserts straight into the Inbox, bypassing Stalwart's spam scoring
and Sieve scripts (unlike mail delivered through the real SMTP port 25). Cloudflare Email Routing
does basic SPF/DMARC filtering on their end before invoking the Worker.

### Setup (one-time)

The `email-worker/` directory contains:
- `src/index.js` — the Worker code.
- `wrangler.toml` — config; intentionally does **not** hardcode `STALWART_URL` (see comment in the
  file) and declares no `[assets]`, so deploying never prompts for a static assets upload.
- `setup.sh` — reads `MAIL_DOMAIN` from `../.env` and runs the CLI steps below, including passing
  `STALWART_URL=https://mail.$MAIL_DOMAIN` to the Worker at deploy time. Nothing to edit by hand.

**Option 1 — CLI (recommended, run in your own terminal):**

```bash
cd email-worker
npx wrangler login                                      # log into Cloudflare, opens a browser
set -a; . ../.env; set +a                                # load MAIL_DOMAIN, ADMIN_PASSWORD
npx wrangler deploy --var "STALWART_URL:https://mail.$MAIL_DOMAIN"  # no assets step
echo -n "$ADMIN_PASSWORD" | npx wrangler secret put STALWART_ADMIN_PASSWORD
npx wrangler email routing enable "$MAIL_DOMAIN"         # adds MX + SPF (TXT) automatically
npx wrangler email routing rules update "$MAIL_DOMAIN" catch-all \
  --action-type worker --action-value stalwart-mail-ingest --enabled true
```

(or just run `./setup.sh` after `wrangler login` — it performs the exact steps above for you).

**Option 2 — Cloudflare dashboard (no CLI) — manual domain entry required:**

Unlike Option 1, the dashboard can't read `.env`, so you type your domain (the same value as
`MAIL_DOMAIN`) directly into two fields below.

1. **Workers & Pages → Create** → pick the **"Hello World" (Worker only)** template — *do not*
   pick Pages/Static Site/any framework, those are the ones that force an assets upload.
   Name it `stalwart-mail-ingest` → Deploy → **Edit code** → paste the full contents of
   `src/index.js` → **Save and deploy**.
2. Worker → **Settings → Variables and Secrets** → add:
   - `STALWART_URL` = `https://mail.<your domain>` (Text) — **← type your real domain here**
   - `STALWART_ADMIN_PASSWORD` = the `ADMIN_PASSWORD` value from `.env` (Secret/encrypt)
3. Select zone **\<your domain> → Email → Email Routing** → **Enable Email Routing** (adds MX/TXT
   automatically, doesn't affect the existing A record for `mail.<your domain>`). — **← type your
   real domain here too**
4. **Routing rules** tab → **Catch-all address** → action **Send to a Worker** → pick
   `stalwart-mail-ingest` → Save.

### Verify

Send a test email from outside (Gmail...) to an existing mailbox, wait ~1 minute, then:

```bash
./stalwart.sh read hello@example.com '<password>'
```

If nothing shows up, check the Worker logs: Cloudflare dashboard → Worker → **Logs** (or
`npx wrangler tail stalwart-mail-ingest`), and confirm the catch-all rule points at the right
worker from step 4.

## Webmail (phone-friendly reader)

`webmail/index.html` is a single self-contained static page (no backend, no build step) that logs
into one mailbox at a time with that mailbox's own email + password and calls Stalwart's JMAP
directly from the browser — list the Inbox, read full message bodies, clickable links. It derives
the server hostname from the email's domain (`hello@example.com` → `https://mail.example.com`), so
the file itself never needs editing.

Being backend-less, it has nowhere to proxy requests through, so the browser calls
`https://mail.$MAIL_DOMAIN/jmap/` directly from a different origin (wherever the page is hosted) —
which **requires enabling permissive CORS on Stalwart**, otherwise the browser blocks every
request:

```bash
set -a; . .env; set +a
export STALWART_URL="http://127.0.0.1:8080" STALWART_USER=admin STALWART_PASSWORD="$ADMIN_PASSWORD"
stalwart-cli update Http --field usePermissiveCors=true
stalwart-cli create Action/ReloadSettings   # applies it without restarting the container
```

**Trade-off:** this is a server-wide setting (`stalwart-cli get Http` to check current value) — it
allows cross-origin requests to Stalwart's entire JMAP API from any website, not just this page.
Each request still needs valid mailbox credentials (Basic Auth), so a random site can't read mail
without already knowing a password, but it's a real loosening of the default same-origin
protection. Skip this step (and don't use `webmail/`) if that trade-off isn't acceptable — the
[Admin console](#admin-console-admin-app) below reads mail server-side instead and needs no CORS
change at all.

To use the page: open `webmail/index.html` directly in a browser (works as a local file), or host
it anywhere that can serve a static file (GitHub Pages, Cloudflare Pages, or publish it as a
Claude Artifact) — there's no server-side piece to deploy.

## Admin console (admin-app)

A self-hosted web app (`admin-app/`, Node.js, zero dependencies besides `stalwart-cli`) that
replaces typing `stalwart.sh` by hand: create/delete domains & mailboxes, view every mailbox's
inbox — all from one page, one admin login.

**Why no per-mailbox password is needed:** the backend holds `STALWART_ADMIN_PASSWORD` and uses
Stalwart's admin privileges to access the JMAP of *any* account (`Principal/query` resolves the
accountId from an email address, then reads/modifies that mailbox directly) — this has been
verified against a real server. When a new mailbox is created through this page, its real Stalwart
password is still set to `DEFAULT_MAILBOX_PASSWORD` (default `Hellototo123$`, overridable via env)
for consistency, but the admin page itself never needs that password to read mail.

### Run via Docker Compose (recommended — joins the `mail` network automatically, calls `http://stalwart:8080` directly)

1. Set `APP_ADMIN_PASSWORD` in `.env` (a random value is auto-generated when the file is first
   created — **change it before exposing this to the Internet**). Optionally set
   `DEFAULT_MAILBOX_PASSWORD` to change the default password assigned to new mailboxes.
2. `docker compose up -d --build admin-app`
3. Open `http://127.0.0.1:3000` (or via an SSH port-forward if the host is remote).

### Run standalone with its own Dockerfile

```bash
cd admin-app
docker build -t stalwart-admin .
docker run -d --name stalwart-admin \
  --network mail_mail \
  -p 127.0.0.1:3000:3000 \
  -e STALWART_URL=http://stalwart:8080 \
  -e STALWART_ADMIN_PASSWORD='<ADMIN_PASSWORD from .env>' \
  -e APP_ADMIN_PASSWORD='<admin page login password>' \
  stalwart-admin
```

`--network mail_mail` is the Docker network Docker Compose already created for the main stack
(`docker network ls` to check the exact name if it differs) — needed so this container can reach
`http://stalwart:8080` by service name. If running on a different host with no shared Docker
network, set `STALWART_URL=https://mail.$MAIL_DOMAIN` (the public endpoint via cloudflared) instead
of the internal name.

### Exposing it to the Internet via cloudflared — manual domain entry required

Reuse the existing `cloudflared` container (no need for a second tunnel container): in the
Cloudflare Zero Trust dashboard → **Networks → Tunnels** → the current tunnel → **Public Hostname**
→ **Add a public hostname**, e.g. `admin.<your domain>` **← type your real domain here, there's no
`.env` on this screen** → Service `http://admin-app:3000` (the service name within the shared
`mail` network). This is the only part that needs the Cloudflare dashboard — everything else on
the page is gated by the `APP_ADMIN_PASSWORD` password.

**Because this will be public:** change `APP_ADMIN_PASSWORD` to a strong value of your own and
keep it secret. The page has built-in login rate limiting (10 failed attempts / 15 min / IP) and
an HMAC-signed session cookie, but it is still a single layer of protection — whoever has the
password can create/delete any mailbox and read every email.
