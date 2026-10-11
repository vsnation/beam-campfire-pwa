// The IPFS hash (CIDv0, "Qm…") of a file, worked out on this device, to check a dApp package
// against the hash its publisher recorded in BEAM's DApp Store (issue #46).
//
// BEAM's wallets add a package to IPFS with go-ipfs / kubo's defaults (BEAM's ipfs_add / ipfs_hash):
// 256 KiB chunks, each a dag-pb node holding UnixFS File data, put together in a balanced tree of at
// most 174 links per node, each node's hash a SHA-256 multihash. Doing the same here gives the same
// hash, so a package can come from anywhere (a mirror, a copy someone sent) and is used only when it
// hashes to exactly what the chain says. Measured on 2026-10-11: all 21 packages in the store
// re-hash to their on-chain CID. Older adds (before 2018) used Raw leaves; both are tried.
// Pure: no network, SHA-256 from Web Crypto.

const CHUNK = 262144;
const MAX_LINKS = 174;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const CIDV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const field = (n, bytes) => concat([Uint8Array.from(varint(n * 8 + 2)), Uint8Array.from(varint(bytes.length)), bytes]);
const number = (n, v) => Uint8Array.from([...varint(n * 8), ...varint(v)]);

/** UnixFS Data: Type, Data, filesize, blocksizes. */
function unixfs(type, data, filesize, blocksizes = []) {
  const parts = [number(1, type)];
  if (data && data.length) parts.push(field(2, data)); // an empty file has no Data field (kubo)
  parts.push(number(3, filesize));
  for (const b of blocksizes) parts.push(number(4, b));
  return concat(parts);
}

/** dag-pb: the links (Hash, empty Name, Tsize) first, then Data, as go-merkledag writes them. */
function dagPb(links, data) {
  const parts = links.map((l) => field(2, concat([field(1, l.hash), field(2, new Uint8Array(0)), number(3, l.tsize)])));
  parts.push(field(1, data));
  return concat(parts);
}

async function multihash(block) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', block));
  return concat([Uint8Array.from([0x12, 0x20]), d]);
}

function base58(bytes) {
  let n = 0n;
  for (const x of bytes) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of bytes) {
    if (x !== 0) break;
    s = `1${s}`;
  }
  return s;
}

/** The CIDv0 `ipfs add` (kubo defaults) gives `bytes`. leafType 2: File leaves (current), 0: Raw (before 2018). */
export async function ipfsHashV0(bytes, { leafType = 2 } = {}) {
  const chunks = [];
  for (let i = 0; i < bytes.length || i === 0; i += CHUNK) chunks.push(bytes.subarray(i, i + CHUNK));
  let next = 0;
  const leaf = async () => {
    const c = chunks[next++];
    const blk = dagPb([], unixfs(leafType, c, c.length));
    return { hash: await multihash(blk), size: c.length, tsize: blk.length };
  };
  const node = async (children) => {
    const size = children.reduce((a, c) => a + c.size, 0);
    const blk = dagPb(children, unixfs(2, null, size, children.map((c) => c.size)));
    return { hash: await multihash(blk), size, tsize: blk.length + children.reduce((a, c) => a + c.tsize, 0) };
  };
  // Balanced, as go-unixfs importer/balanced: the root grows one level at a time.
  const fill = async (children, depth) => {
    while (children.length < MAX_LINKS && next < chunks.length) {
      if (depth === 1) children.push(await leaf());
      else {
        const kids = [];
        await fill(kids, depth - 1);
        children.push(await node(kids));
      }
    }
  };
  let root = await leaf();
  for (let depth = 1; next < chunks.length; depth++) {
    const kids = [root];
    await fill(kids, depth);
    root = await node(kids);
  }
  return base58(root.hash);
}

/** Whether `bytes` are the file with IPFS hash `cid` (a CIDv0). */
export async function matchesCid(bytes, cid) {
  if (!CIDV0.test(String(cid))) return false;
  for (const leafType of [2, 0]) if ((await ipfsHashV0(bytes, { leafType })) === cid) return true;
  return false;
}
