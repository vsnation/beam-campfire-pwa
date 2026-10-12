#!/bin/sh
# Serve a BEAM Campfire release only after it verified, the way the app verifies it.
#
#   sh /etc/beam-campfire/verify_and_switch.sh <checkout> <site> [--key <release_public.jwk>] [--keep 3]
#
# <checkout>  a freshly pulled checkout of the hosting repository
#             (git -C <checkout> pull --ff-only). Untrusted: whoever can push to that
#             repository decides what is in it. It is never served itself.
# <site>      the folder the web server serves from: <site>/current is a symlink to
#             <site>/releases/<version>-<manifest hash>/, and nginx's root is <site>/current.
# --key       the release public key, pinned on the server: a copy of
#             pwa/keys/release_public.jwk from the source repository, checked by hand once.
#             Default /etc/beam-campfire/release_public.jwk.
# --keep      release folders to keep besides the one served (for a rollback). Default 3.
#
# This script and the key must live outside both the checkout and <site>, owned by root and
# read-only to the user that runs it (install them once in /etc/beam-campfire/). A copy inside the
# checkout is whatever the last push made it, and <site> is writable by the user that runs this:
# either would let a push change the checker or the key it trusts. Both are refused.
#
# What it checks before anything is served (src/lib/release.js, src/lib/update_sources.js):
#   release.sig is an ECDSA P-256 / SHA-256 signature of release.json's exact bytes under the
#   pinned key; release.json names this app, a version and the manifest's SHA-256;
#   manifest.json hashes to it and lists safe paths, each once, as many as the release says;
#   every listed file is a plain file (no symlink anywhere on its path) with its signed size and
#   SHA-256; the version is not older than the one served, and a release that claims the
#   served version must be the served release.
# The files are read once, hashed as they are written into a new release folder, and only that
# folder is served: what was checked is exactly what is served, and nothing else of the
# checkout (.git, README.md, deploy/) is. DApp Store packages (dapp-store/Qm<46>.dapp) are copied
# too; the app checks each against the IPFS hash its publisher recorded on chain.
# The switch is one rename of the "current" symlink: a request sees the old release or the
# new one, never a mix. Anything wrong: exit 1 with the reason, "current" untouched.
#
# Needs python3 and openssl (both on any Ubuntu server). Run as the user that owns <site>, not
# root, e.g. from the deploy hook right after the pull:
#   git -C /srv/beam-campfire-pwa pull --ff-only && \
#     sh /etc/beam-campfire/verify_and_switch.sh /srv/beam-campfire-pwa /srv/beam-campfire
set -eu
for tool in python3 openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "verify_and_switch: needs $tool" >&2; exit 2; }
done
exec python3 - "$0" "$@" <<'PY'
import base64, errno, fcntl, hashlib, json, os, re, shutil, subprocess, sys, tempfile

APP = 'beam-campfire-pwa'
META = ('release.json', 'release.sig', 'manifest.json')
MAX_META = 4 * 1024 * 1024
MAX_PACKAGE = 64 * 1024 * 1024
PATH_OK = re.compile(r'^[A-Za-z0-9._\-/]+$')
PACKAGE = re.compile(r'^Qm[1-9A-HJ-NP-Za-km-z]{44}\.dapp$')


class Refused(Exception):
    pass


def usage():
    print('usage: sh verify_and_switch.sh <checkout> <site> [--key <release_public.jwk>] [--keep 3]', file=sys.stderr)
    sys.exit(2)


DEFAULT_KEY = '/etc/beam-campfire/release_public.jwk'
self_path = os.path.realpath(sys.argv[1])  # this script, as the shell ran it ($0)
args = sys.argv[2:]
opts = {'--key': None, '--keep': '3'}
pos = []
i = 0
while i < len(args):
    if args[i] in opts and i + 1 < len(args):
        opts[args[i]] = args[i + 1]
        i += 2
    elif args[i].startswith('--'):
        usage()
    else:
        pos.append(args[i])
        i += 1
if len(pos) != 2 or not opts['--keep'].isdigit():
    usage()
checkout = os.path.realpath(pos[0])
site = os.path.realpath(pos[1])
key_path = os.path.realpath(opts['--key'] or DEFAULT_KEY)
keep = int(opts['--keep'])


def inside(path, folder):
    return path == folder or path.startswith(folder + os.sep)


def b64url(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def version_tuple(v):
    return tuple(int(n) for n in v.split('.'))


def read_plain(rel, limit, too_big='is larger than it may be'):
    """A file of the checkout: a plain file, no symlink anywhere on its path, at most limit bytes."""
    full = os.path.join(checkout, rel)
    if os.path.realpath(full) != os.path.normpath(full):
        raise Refused(f'{rel} is not a plain file of the checkout (a symlink on its path)')
    try:
        fd = os.open(full, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise Refused(f'{rel} is not a plain file of the checkout (a symlink)')
        raise Refused(f'{rel} is missing from the checkout')
    with os.fdopen(fd, 'rb') as f:
        if not os.path.stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise Refused(f'{rel} is not a plain file of the checkout')
        data = f.read(limit + 1)
    if len(data) > limit:
        raise Refused(f'{rel} {too_big}')
    return data


def where_things_are():
    """The checker and the key it trusts must be out of reach of a push (audit UPD-1)."""
    if inside(site, checkout) or inside(checkout, site):
        raise Refused('the checkout and the served folder must be separate folders')
    if not os.path.isfile(self_path):
        raise Refused('cannot tell where this script is: run it by its path, e.g. sh /etc/beam-campfire/verify_and_switch.sh <checkout> <site>')
    for what, path in (('this script', self_path), ('the release key', key_path)):
        for folder, name in ((checkout, 'the checkout it would judge'), (site, 'the folder it serves')):
            if inside(path, folder):
                runs = 'runs from' if what == 'this script' else f'{path} is'
                raise Refused(f'{what} {runs} inside {name}, so a push could change it: '
                              'install it outside both, e.g. in /etc/beam-campfire/, owned by root and read-only to this user')
    for path in (self_path, key_path):
        if os.path.exists(path) and os.access(path, os.W_OK) and os.geteuid() != 0:
            print(f'verify_and_switch: warning: {path} can be changed by the user running this; make it owned by root and read-only', file=sys.stderr)


def public_key_pem():
    try:
        jwk = json.load(open(key_path))
    except (OSError, ValueError):
        raise Refused(f'no readable release key at {key_path}')
    if jwk.get('kty') != 'EC' or jwk.get('crv') != 'P-256' or 'd' in jwk:
        raise Refused('the release key must be a public P-256 key')
    x, y = b64url(jwk['x']), b64url(jwk['y'])
    if len(x) != 32 or len(y) != 32:
        raise Refused('the release key is malformed')
    spki = bytes.fromhex('3059301306072a8648ce3d020106082a8648ce3d030107034200') + b'\x04' + x + y
    return b'-----BEGIN PUBLIC KEY-----\n' + base64.encodebytes(spki) + b'-----END PUBLIC KEY-----\n'


def der_int(b):
    b = b.lstrip(b'\x00') or b'\x00'
    if b[0] & 0x80:
        b = b'\x00' + b
    return b'\x02' + bytes([len(b)]) + b


def verify_signature(release_bytes, sig_text):
    try:
        raw = base64.b64decode(sig_text.strip(), validate=True)
    except ValueError:
        raise Refused('release.sig is not readable')
    if len(raw) != 64:
        raise Refused('release.sig is not a P-256 signature')
    body = der_int(raw[:32]) + der_int(raw[32:])
    with tempfile.TemporaryDirectory() as t:
        for name, data in (('key.pem', public_key_pem()), ('sig.der', b'\x30' + bytes([len(body)]) + body), ('release.json', release_bytes)):
            with open(os.path.join(t, name), 'wb') as f:
                f.write(data)
        r = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', os.path.join(t, 'key.pem'), '-signature', os.path.join(t, 'sig.der'), os.path.join(t, 'release.json')], capture_output=True)
    if r.returncode != 0:
        raise Refused('release.sig is not a valid signature of release.json under the pinned BEAM Campfire release key')


def served_release():
    try:
        return json.load(open(os.path.join(site, 'current', 'release.json')))
    except (OSError, ValueError):
        return None


def write(dst_root, rel, data):
    dst = os.path.join(dst_root, rel)
    os.makedirs(os.path.dirname(dst), mode=0o755, exist_ok=True)
    with open(dst, 'xb') as f:
        f.write(data)
    os.chmod(dst, 0o644)


def main():
    meta = {name: read_plain(name, MAX_META) for name in META}
    verify_signature(meta['release.json'], meta['release.sig'].decode('ascii', 'replace'))
    rel = json.loads(meta['release.json'])
    if rel.get('app') != APP or not re.fullmatch(r'\d+\.\d+\.\d+', str(rel.get('version'))) or not re.fullmatch(r'[0-9a-f]{64}', str(rel.get('manifest_sha256'))):
        raise Refused('release.json is missing fields')
    version = rel['version']
    if hashlib.sha256(meta['manifest.json']).hexdigest() != rel['manifest_sha256']:
        raise Refused("manifest.json is not the file list that was signed")
    man = json.loads(meta['manifest.json'])
    files = man.get('files')
    if man.get('app') != APP or man.get('version') != version or not isinstance(files, list):
        raise Refused('manifest.json does not belong to this release')
    if isinstance(rel.get('file_count'), int) and rel['file_count'] != len(files):
        raise Refused('manifest.json: the file count differs from the signed release')
    seen = set()
    for f in files:
        p = f.get('path') if isinstance(f, dict) else None
        if not isinstance(p, str) or not PATH_OK.match(p) or '..' in p or p.startswith('/') or p in META or p in seen:
            raise Refused(f'manifest.json: bad path {p!r}')
        if not re.fullmatch(r'[0-9a-f]{64}', str(f.get('sha256'))) or not isinstance(f.get('size'), int) or f['size'] < 0:
            raise Refused(f'manifest.json: bad entry for {p}')
        seen.add(p)

    name = f"{version}-{rel['manifest_sha256'][:16]}"
    now = served_release()
    if now and isinstance(now.get('version'), str) and re.fullmatch(r'\d+\.\d+\.\d+', now['version']):
        if version_tuple(version) < version_tuple(now['version']):
            raise Refused(f"release {version} is older than the one served ({now['version']})")
        if version == now['version']:
            if now.get('manifest_sha256') != rel['manifest_sha256']:
                raise Refused(f'a different release claims version {version}, which is served')
            print(f'verify_and_switch: already serving {version} ({os.readlink(os.path.join(site, "current"))})')
            return

    releases = os.path.join(site, 'releases')
    os.makedirs(releases, mode=0o755, exist_ok=True)
    staging = tempfile.mkdtemp(prefix='.tmp-', dir=releases)
    try:
        os.chmod(staging, 0o755)
        for f in files:
            data = read_plain(f['path'], f['size'], 'is not the signed file (larger)')
            if len(data) != f['size'] or hashlib.sha256(data).hexdigest() != f['sha256']:
                raise Refused(f"{f['path']} is not the signed file")
            write(staging, f['path'], data)
        for n in META:
            write(staging, n, meta[n])
        packages = 0
        store = os.path.join(checkout, 'dapp-store')
        if os.path.isdir(store) and not os.path.islink(store):
            for n in sorted(os.listdir(store)):
                if PACKAGE.match(n):
                    try:
                        write(staging, f'dapp-store/{n}', read_plain(f'dapp-store/{n}', MAX_PACKAGE))
                        packages += 1
                    except Refused as e:
                        print(f'verify_and_switch: skipped {e}', file=sys.stderr)
        target = os.path.join(releases, name)
        if os.path.lexists(target):
            shutil.rmtree(target)
        os.rename(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    link = os.path.join(site, f'.current-{os.getpid()}')
    os.symlink(os.path.join('releases', name), link)
    os.replace(link, os.path.join(site, 'current'))  # one rename: atomic
    print(f'verify_and_switch: now serving {version} (releases/{name}, {len(files)} files, {packages} DApp Store packages)')

    # Older release folders beyond --keep go; the served one never does.
    others = [d for d in os.listdir(releases) if d != name and not d.startswith('.')]
    others.sort(key=lambda d: os.path.getmtime(os.path.join(releases, d)), reverse=True)
    for d in others[keep:]:
        shutil.rmtree(os.path.join(releases, d), ignore_errors=True)


try:
    where_things_are()
    os.makedirs(site, exist_ok=True)
    with open(os.path.join(site, '.verify_and_switch.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        main()
except BlockingIOError:
    print('verify_and_switch: another run is in progress', file=sys.stderr)
    sys.exit(1)
except Refused as e:
    print(f'verify_and_switch: REFUSED, still serving what was served before: {e}', file=sys.stderr)
    sys.exit(1)
PY
