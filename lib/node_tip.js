// A BEAM node's newest block, asked over its own protocol: what the node screen shows for each of
// BEAM's public nodes (screens/node.js). Only the tip, and only what a node volunteers.
//
// BEAM's wss port (`beam-node --websocket_port`, beam/cli.cpp WebSocketProxy) forwards the raw P2P
// stream to the node, so this speaks BEAM's protocol (core/proto.cpp, tag beam-7.5.14493):
//   1. Both sides send SChannelInitiate in plaintext: an ephemeral secp256k1 public key, its
//      x-coordinate only (PeerID; the secret is negated so that Y is even, PeerID::FromSk).
//   2. The node answers ours with SChannelReady (plaintext), switches its outgoing stream to
//      AES-256-CTR + an 8-byte HMAC-SHA256 tag, and right away sends GetTime, Authentication, Login
//      and NewTip: its newest block header (Node::Peer::OnConnectedSecure). No login of ours is
//      needed, and nothing of this wallet is sent: the key is random, made for one check, then dropped.
//   3. The check reads up to NewTip, verifies each message's tag, takes the height and the block's
//      timestamp, and closes.
// Keys (InitViaDiffieHellman): secret = SHA-256(shared point x || Y parity); AES key and HMAC key =
// secret; the node's counter = the last 16 bytes of SHA-256(secret || our PeerID), incremented as a
// 128-bit big-endian number (AES::StreamCipher); a tag is the last 8 bytes of the HMAC over the
// header and body. Messages: 8-byte header 'B' 'm' 10, type, size (uint32 LE, tag included).
//
// The node's words are display only: the wallet never syncs from them, sends nothing on them, and
// the engine keeps its own rules. A node that sends anything unexpected is "not answering".

import { secp256k1 } from '../vendor/noble/noble-curves/secp256k1.js';
import { sha256 } from '../vendor/noble/noble-hashes/sha2.js';
import { hmac } from '../vendor/noble/noble-hashes/hmac.js';

export const MSG = { Bye: 0x01, SChannelInitiate: 0x04, SChannelReady: 0x05, NewTip: 0x10 };
const HEADER = [0x42, 0x6d, 10];
const HEADER_BYTES = 8;
const TAG_BYTES = 8;
const KEY_BYTES = 32;
// Everything the node says before NewTip is a few hundred bytes; past this it is not answering as BEAM does.
export const MAX_ENCRYPTED = 16384;
const MAX_PLAIN_MSG = 64;

const N = secp256k1.Point.Fn.ORDER;

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const toBig = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
function fromBig(n, len = 32) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

/** An 8-byte header and the body: one BEAM message. */
export function frame(type, body = new Uint8Array(0)) {
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out.set(HEADER, 0);
  out[3] = type;
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, HEADER_BYTES);
  return out;
}

/**
 * A one-check key pair, as PeerID::FromSk makes it: {sk, pub} with pub the 32-byte x of sk·G and
 * sk negated when Y would be odd. `secret`: 32 bytes for tests; random otherwise.
 */
export function nonceKey(secret = secp256k1.utils.randomSecretKey()) {
  let sk = secret;
  const p = secp256k1.getPublicKey(sk, true);
  if (p[0] === 0x03) sk = fromBig(N - toBig(sk));
  return { sk, pub: p.slice(1) };
}

/** The keys both sides derive (InitViaDiffieHellman). `forPub`: the PeerID whose incoming stream it opens. */
export function channelKeys(mySk, remotePub, forPub) {
  const shared = secp256k1.getSharedSecret(mySk, concat([0x02], remotePub), true);
  const secret = sha256(concat(shared.slice(1), [shared[0] === 0x03 ? 1 : 0]));
  const counter = sha256(concat(secret, forPub)).slice(16);
  return { secret, counter };
}

/** `n` bytes of AES-256-CTR keystream from `counter` (WebCrypto: the same 128-bit big-endian counter). */
export async function keystream({ secret, counter }, n, subtle = globalThis.crypto.subtle) {
  const key = await subtle.importKey('raw', secret, { name: 'AES-CTR' }, false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, key, new Uint8Array(n)));
}

/** The tag a message carries: the last 8 bytes of HMAC-SHA256(secret, header and body). */
export const tagOf = (secret, bytes) => hmac(sha256, secret, bytes).slice(-TAG_BYTES);

/** yas "compacted" unsigned integer (utility/serialize.h): one byte 0x80|v under 128, else a length byte and that many bytes LE. */
export function readCompact(b, o) {
  if (o >= b.length) throw new Error('short');
  const first = b[o];
  if (first & 0x80) return { value: first & 0x7f, next: o + 1 };
  if (first < 1 || first > 8 || o + 1 + first > b.length) throw new Error('bad integer');
  let v = 0n;
  for (let i = first; i >= 1; i--) v = (v << 8n) | BigInt(b[o + i]);
  return { value: v > BigInt(Number.MAX_SAFE_INTEGER) ? NaN : Number(v), next: o + 1 + first };
}

/** NewTip's Block::SystemState::Full: height, then Prev, ChainWork, Kernels, Definition (32 bytes each), then the timestamp. */
export function parseTip(body) {
  const h = readCompact(body, 0);
  const t = readCompact(body, h.next + 4 * 32);
  if (!Number.isSafeInteger(h.value) || h.value <= 0 || !Number.isSafeInteger(t.value) || t.value <= 0) throw new Error('bad tip');
  return { height: h.value, timestamp: t.value };
}

/**
 * One check, fed the node's bytes as they arrive. start() gives what to send first;
 * push(bytes) resolves to null (more needed) or {height, timestamp}; it throws on anything else.
 */
export class TipReader {
  constructor({ secret, subtle } = {}) {
    this.key = nonceKey(secret);
    this.subtle = subtle;
    this.buf = new Uint8Array(0);
    this.remote = null;
    this.ready = false;
    this.cipher = null;
    this.stream = null;
    this.enc = 0; // encrypted bytes consumed
    this.chain = Promise.resolve(null);
  }

  /** Our SChannelInitiate. */
  start() {
    return frame(MSG.SChannelInitiate, this.key.pub);
  }

  push(bytes) {
    this.buf = concat(this.buf, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    this.chain = this.chain.then((done) => done || this.advance());
    return this.chain;
  }

  async advance() {
    // Plaintext: the node's SChannelInitiate and SChannelReady, in either order of arrival relative to ours.
    while (!this.ready) {
      if (this.buf.length < HEADER_BYTES) return null;
      const hd = this.buf;
      if (hd[0] !== HEADER[0] || hd[1] !== HEADER[1] || hd[2] !== HEADER[2]) throw new Error('not a BEAM node');
      const size = new DataView(hd.buffer, hd.byteOffset).getUint32(4, true);
      if (size > MAX_PLAIN_MSG) throw new Error('unexpected message');
      if (this.buf.length < HEADER_BYTES + size) return null;
      const body = this.buf.slice(HEADER_BYTES, HEADER_BYTES + size);
      this.buf = this.buf.slice(HEADER_BYTES + size);
      if (hd[3] === MSG.SChannelInitiate && size === 32 && !this.remote) this.remote = body;
      else if (hd[3] === MSG.SChannelReady && size === 0 && this.remote) this.ready = true;
      else if (hd[3] === MSG.Bye) throw new Error('the node said goodbye');
      else throw new Error('unexpected message');
    }
    if (!this.cipher) {
      this.cipher = channelKeys(this.key.sk, this.remote, this.key.pub);
      this.stream = await keystream(this.cipher, MAX_ENCRYPTED, this.subtle);
    }
    // Encrypted: message after message until NewTip. The header is decrypted first to learn the size.
    for (;;) {
      if (this.buf.length < HEADER_BYTES) return null;
      if (this.enc + HEADER_BYTES > MAX_ENCRYPTED) throw new Error('no tip');
      const head = this.xor(this.buf.slice(0, HEADER_BYTES), this.enc);
      if (head[0] !== HEADER[0] || head[1] !== HEADER[1] || head[2] !== HEADER[2]) throw new Error('not a BEAM node');
      const size = new DataView(head.buffer).getUint32(4, true);
      if (size < TAG_BYTES || this.enc + HEADER_BYTES + size > MAX_ENCRYPTED) throw new Error('no tip');
      if (this.buf.length < HEADER_BYTES + size) return null;
      const msg = this.xor(this.buf.slice(0, HEADER_BYTES + size), this.enc);
      this.buf = this.buf.slice(HEADER_BYTES + size);
      this.enc += HEADER_BYTES + size;
      const tag = tagOf(this.cipher.secret, msg.slice(0, msg.length - TAG_BYTES));
      if (!tag.every((b, i) => b === msg[msg.length - TAG_BYTES + i])) throw new Error('bad tag');
      if (msg[3] === MSG.NewTip) return parseTip(msg.slice(HEADER_BYTES, msg.length - TAG_BYTES));
      if (msg[3] === MSG.Bye) throw new Error('the node said goodbye');
    }
  }

  xor(bytes, at) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ this.stream[at + i];
    return out;
  }
}

/**
 * Asks one node for its newest block over `socket` (a WebSocket-like object: binaryType, send,
 * close, onopen/onmessage/onerror/onclose). Resolves {ok: true, height, timestamp, ms} or
 * {ok: false, code}; never rejects; always closes the socket.
 */
export function checkTip(openSocket, { timeoutMs = 8000, now = () => performance.now(), secret } = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    let ws = null;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws) ws.close();
      } catch {
        /* closing is best effort */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs);
    const reader = new TipReader({ secret });
    try {
      ws = openSocket();
    } catch (e) {
      finish({ ok: false, code: 'refused', error: e && e.message });
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      try {
        ws.send(reader.start());
      } catch {
        finish({ ok: false, code: 'closed' });
      }
    };
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return finish({ ok: false, code: 'protocol' });
      reader.push(new Uint8Array(e.data)).then(
        (tip) => tip && finish({ ok: true, ...tip, ms: Math.max(1, Math.round(now() - t0)) }),
        (err) => finish({ ok: false, code: 'protocol', error: err.message }),
      );
    };
    ws.onerror = () => finish({ ok: false, code: 'unreachable' });
    ws.onclose = () => finish({ ok: false, code: 'closed' });
  });
}
