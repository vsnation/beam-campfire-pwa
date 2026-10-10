# BEAM Campfire — web wallet (PWA)

The BEAM Campfire wallet for iPhone (and any modern browser), without an app store. This repository
is the signed build itself: these files are the whole app.

**Open it:** https://vsnation.github.io/beam-campfire-pwa/

**Download it:** every release is also one signed zip, so the app outlives this site:
https://github.com/vsnation/campfire-beam/releases (the `web-v…` releases).

## Install on iPhone

1. Open the link above in **Safari**.
2. Wait for "Setting up" to finish (it happens once).
3. Tap Share → **Add to Home Screen** → Add, then open **BEAM Campfire from the Home Screen**.
4. Create a wallet, restore one with your 12 words, or import a `wallet.db` file.

## It keeps working without this site

- After the first open, the whole app is stored on your phone and runs from there. It does not
  need this site again — not to start, unlock, sync, send or receive.
- If this site goes offline, disappears or shows something else, your installed app keeps
  working. (Measured in Safari and Chrome: a site that is down, returns "not found" or shows a
  parking page leaves the installed app and its wallets intact.)
- Updates happen only when you tap **Check for update**, and only to a release signed with BEAM
  Campfire's key.
- Your funds never depend on this app: keep your **12 words** (or the **wallet.db file and its
  password** for an imported wallet). They open your wallet in any BEAM wallet, including
  [BEAM Campfire for desktop and Android](https://github.com/vsnation/campfire-beam/releases).

One limit no website can remove: whoever controls a web address can replace the app served from
it. If a copy you use ever asks for your password in an unexpected way after an update you did
not start, don't enter it — open your wallet from your 12 words or wallet.db elsewhere.

## Host your own copy

Anyone can host this app; every copy is the same signed build. Your copy is its own app for the
people who install it from your address.

Requirements:
- **HTTPS**, and an address used **only** for this app (for example `wallet.yourdomain.org`).
  Never put other sites on the same address: they would share its storage.
- The security headers below on every response. (The app also adds them itself once installed.)

### On your own computer, with no website at all

Unpack the release zip, then in that folder:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Open http://127.0.0.1:8080 in Chrome or Edge (and Install, if you like). Once it has opened, it
runs from the browser's own copy: it keeps working with the command stopped. Keep the same port
next time; another port is another app with its own wallets. An iPhone cannot do this: Safari
needs an HTTPS address once to install the app.

### On a VPS with Caddy (automatic HTTPS)

```bash
sudo apt install -y caddy git
sudo git clone --depth 1 https://github.com/vsnation/beam-campfire-pwa /srv/beam-campfire
sudo tee /etc/caddy/Caddyfile < /srv/beam-campfire/deploy/Caddyfile   # then edit the domain name
sudo systemctl reload caddy
```

`deploy/Caddyfile` serves the files with the right headers, keeps no logs of visitors' IP
addresses, and relays BEAM's recovery snapshot (needed for "Restore with 12 words") and an
explorer height, so the phone talks only to your address and the BEAM node.

To update your copy later: `sudo git -C /srv/beam-campfire pull` — the app on people's phones still
updates only when they choose to, and only to a signed release.

### On a VPS with nginx

Use `deploy/nginx.conf` (same headers and relays), with your certificate.

### On a static host (Netlify, Cloudflare Pages)

Upload all files as they are; `_headers` sets the security headers. Static hosts cannot relay
BEAM's recovery snapshot, so "Restore with 12 words" asks for the recovery file on such hosts;
creating a wallet, importing a wallet.db and every installed wallet work as usual.

### Check that a copy is genuine

Every file is listed with its SHA-256 in `manifest.json`, whose own SHA-256 is in `release.json`,
which is signed (`release.sig`). From a copy of these files:

```bash
python3 -c "import json,hashlib;m=json.load(open('manifest.json'));b=[f['path'] for f in m['files'] if hashlib.sha256(open(f['path'],'rb').read()).hexdigest()!=f['sha256']];print('all files match' if not b else b)"
python3 -c "import json,hashlib;print(json.load(open('release.json'))['manifest_sha256']==hashlib.sha256(open('manifest.json','rb').read()).hexdigest())"
```

Compare `manifest_sha256` in `release.json` with the one in this repository's history.

Source code and how the app is built: https://github.com/vsnation/campfire-beam (`pwa/`).
