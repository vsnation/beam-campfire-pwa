# Beam PWA — web wallet (PWA)

The Beam PWA wallet for iPhone (and any modern browser), without an app store. This repository
is the signed build itself: these files are the whole app.

**Open it:** https://pwa.buybeam.my/

**Download it:** every release is also one signed zip, so the app outlives this site:
https://github.com/vsnation/campfire-beam/releases (the `web-v…` releases).

This repository, and the same files on GitHub Pages (vsnation.github.io/beam-campfire-pwa/), are an update source:
installed apps fetch signed updates here when pwa.buybeam.my is gone, and the app there works as a
full copy (create, restore and import), so it is the way in when pwa.buybeam.my cannot be reached.
A wallet is kept by the browser per web address, so one made at pwa.buybeam.my is not in this copy:
bring it with your 12 words or its wallet.db file.

## Install on iPhone

1. Open https://pwa.buybeam.my/ in **Safari**.
2. Wait for "Setting up" to finish (it happens once).
3. Tap Share → **Add to Home Screen** → Add, then open **Beam PWA from the Home Screen**.
4. Create a wallet, restore one with your 12 words, or import a `wallet.db` file.

## It keeps working without this site

- After the first open, the whole app is stored on your phone and runs from there. It does not
  need this site again — not to start, unlock, sync, send or receive.
- If the site goes offline, disappears or shows something else, your installed app keeps
  working. (Measured in Safari and Chrome: a site that is down, returns "not found" or shows a
  parking page leaves the installed app and its wallets intact.)
- Updates happen only when you tap **Check for updates**, and only to a release signed with BEAM
  Campfire's key. Each check asks pwa.buybeam.my and the public copies, and takes the newest
  signed release.
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
  Never put other sites on the same address, and never a shared one such as `<you>.github.io`:
  they would share its storage.
- The security headers in `deploy/` on every response. (The app also adds them itself once
  installed.)
- Serve only a release that verified: `deploy/verify_and_switch.sh` checks a pulled copy of this
  repository against the release key and serves exactly the signed files.

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
sudo apt install -y caddy git python3 openssl
sudo git clone --depth 1 https://github.com/vsnation/beam-campfire-pwa /srv/beam-campfire-pwa
sudo mkdir -p /srv/beam-campfire && sudo chown "$USER" /srv/beam-campfire
# The checker and the release key live outside the checkout and outside the served folder, owned
# by root: a push to this repository can change neither. Install the checker once, after reading
# it (it is pwa/deploy/verify_and_switch.sh in github.com/vsnation/campfire-beam; compare the two).
sudo install -d -o root -g root -m 755 /etc/beam-campfire
sudo install -o root -g root -m 644 /srv/beam-campfire-pwa/deploy/verify_and_switch.sh /etc/beam-campfire/verify_and_switch.sh
# The release key (the same as pwa/keys/release_public.jwk in github.com/vsnation/campfire-beam;
# compare the two before you trust either):
echo '{"kty":"EC","crv":"P-256","x":"nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc","y":"hHBISFLKDalMgMsjuW78PAMirodfcnlZ5N3-9A9Pa9A"}' | sudo tee /etc/beam-campfire/release_public.jwk
sudo chmod 644 /etc/beam-campfire/release_public.jwk
sh /etc/beam-campfire/verify_and_switch.sh /srv/beam-campfire-pwa /srv/beam-campfire
sudo tee /etc/caddy/Caddyfile < /srv/beam-campfire-pwa/deploy/Caddyfile   # then edit the domain name
sudo systemctl reload caddy
```

`deploy/Caddyfile` serves `/srv/beam-campfire/current` (the verified release) with the right
headers, keeps no logs of visitors' IP addresses, and relays BEAM's recovery snapshot (needed for
"Restore with 12 words") and an explorer height, so the phone talks only to your address and the
BEAM node.

To update your copy later:
`sudo git -C /srv/beam-campfire-pwa pull --ff-only && sh /etc/beam-campfire/verify_and_switch.sh /srv/beam-campfire-pwa /srv/beam-campfire`
— it switches only to a release whose signature and files check out, and never to an older one.
Always run the installed copy in `/etc/beam-campfire/`, never the one in the checkout: the checker
refuses to run from inside the checkout or the served folder, and refuses a key kept in either.
The app on people's phones still updates only when they choose to, and only to a signed release.

### On a VPS with nginx

Use `deploy/nginx.conf` (same headers and relays; nginx 1.24 or newer), with your certificate,
and the checker installed in `/etc/beam-campfire/` as above. Then check what your address really serves:
`node tools/check_deploy.mjs https://<your address>/` from the source repository.

### On a static host (Netlify, Cloudflare Pages)

Upload all files as they are; `_headers` sets the security headers. Static hosts cannot relay
BEAM's recovery snapshot, so "Restore with 12 words" reads it from pwa.buybeam.my or asks for the
recovery file; creating a wallet, importing a wallet.db and every installed wallet work as usual.

### BEAM's DApp Store packages (`dapp-store/`)

The DApp Store in the app lists dApps from BEAM's on-chain store. Their packages live on IPFS in BEAM's
private network, which a browser cannot reach, so this site keeps a copy of each: `dapp-store/<IPFS
hash>.dapp`. The app installs one only if its bytes hash to exactly the IPFS hash its publisher
recorded on the chain, so a copy can be missing but never different. Copy this folder too when you
host your own copy (`verify_and_switch.sh` does); without it the store still lists every dApp and
offers Install from a file.

### Check that a copy is genuine

Every file is listed with its SHA-256 in `manifest.json`, whose own SHA-256 is in `release.json`,
which is signed (`release.sig`). `deploy/verify_and_switch.sh` checks all three and the signature.
From a copy of these files, the hashes alone:

```bash
python3 -c "import json,hashlib;m=json.load(open('manifest.json'));b=[f['path'] for f in m['files'] if hashlib.sha256(open(f['path'],'rb').read()).hexdigest()!=f['sha256']];print('all files match' if not b else b)"
python3 -c "import json,hashlib;print(json.load(open('release.json'))['manifest_sha256']==hashlib.sha256(open('manifest.json','rb').read()).hexdigest())"
```

Compare `manifest_sha256` in `release.json` with the one in this repository's history.

Source code and how the app is built: https://github.com/vsnation/campfire-beam (`pwa/`).
