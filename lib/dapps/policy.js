// What a dApp may ask the wallet to sign through process_invoke_data, and
// with which keys through sign_message. The same rules as the desktop's
// DappContractPolicy and DappWalletKeys:
//
// - No privilege: stored app code re-run with privilege above 0 would use
//   the wallet's own keys.
// - No names: BANS and its Anon-Vault move the person's BEAM names and the
//   payments sent to them with the person's key; no dApp may call them.
// - No wallet keys: a call (or a message signature) with a key BEAM
//   Campfire's own features use could give away what those keys control.
// - No spend ceiling: a stored ceiling (SaveSpendMax) is what the core lets
//   a rebuilt dependent call spend later without asking again, and the
//   approve sheet never shows it (see checkContractData).
// - No unknown code to redo the call later: a rebuilt call is signed without
//   these checks, so only known app bodies may be stored (checkRebuild).
//
// A contract call signs with key hashes chosen by its app shader; the core
// derives the private key from the wallet's master key and that hash, where
// the hash is SHA-256("bvm.m.key\0" || id). The ids below are public (BANS
// uses its own contract id), so any dApp could otherwise ask for them.

import { decodeInvokeData, InvokeDataError, FLAG_SAVE_SPEND_MAX, FLAG_DEPENDENT, FLAG_SAVE_APP_INVOKE } from './invoke_data.js';
import { REBUILD_BODIES } from './catalogue.js';
import { RPC, RpcError, hasHiddenText } from './rpc.js';

export const BANS_CID = 'af4550f1f8a6051ffeffea06e0cb978f8076fdfc2101d2273d4e62c86540bc5e';
export const VAULT_ANON_CID = 'a3385e50cf33afc9f769ee1d82d56b73046d680d343977f36d9a303d7bcdc4da';
export const AIRDROP_CID = '8737e0d39575d7015fdea259fa091e41fc293e6c3d54e80d529033c349b5b18e';

/** Contracts no dApp may call. */
export const FORBIDDEN_CONTRACTS = Object.freeze(new Set([BANS_CID, VAULT_ANON_CID]));

/**
 * Key hashes no dApp may sign with, and what each controls (a unit test
 * derives them again): BANS MyKeyID(cid), airdrop MyAccountID{cid, 0},
 * airdrop OwnerAccountID{0xAD, 42}.
 */
export const RESERVED_KEYS = Object.freeze({
  '40ceff526e1f93763a4d67d995c5359e55b607217290348cc751fc35135c6d93': 'your BEAM names',
  '0c7db6b034f173b462f77bdee28c04ed13a3a0da63b5f71074a858548bedd2dd': 'your airdrops',
  '4cb11163df5323c8f3c55158894f7212a4a5934100bcd1878f47ddd8e60cb30f': 'the airdrop contract',
});

export const KNOWN_CONTRACTS = Object.freeze({
  '729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf': 'Beam DEX',
  [BANS_CID]: 'BEAM names (BANS)',
  [VAULT_ANON_CID]: 'BANS name payments vault',
  '0066b12078623df132b691001b25d7eb94b207b42c018020c9e58152e21ecd25': 'BeamX DAO vault',
  [AIRDROP_CID]: 'BEAM Campfire airdrops',
  '295fe749dc12c55213d1bd16ced174dc8780c020f59cb17749e900bb0c15d868': 'Asset minter',
  '5ab408982b148210e88f180114f10222a2235eafeede0a3a224fda0e523e17b7': 'Black hole (burns assets)',
});

export class PolicyRefusal extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason; // 'unreadable' | 'privileged' | 'spend_ceiling' | 'hidden_text' | 'forbidden_contract' | 'reserved_key' | 'rebuild'
  }
}

/** Throws PolicyRefusal when a dApp may not submit this raw_data. Returns the decoded data otherwise. */
export function checkContractData(raw) {
  let data;
  try {
    data = decodeInvokeData(raw);
  } catch (e) {
    if (e instanceof InvokeDataError) throw new PolicyRefusal('unreadable', "BEAM Campfire refused this request: it can't read all of it, so it can't show you what would be signed. Nothing was sent.");
    throw e;
  }
  if (data.appPrivilege !== null && data.appPrivilege !== 0) {
    throw new PolicyRefusal('privileged', "BEAM Campfire refused this request: it asks the wallet to run the dApp's own code with extra privileges. Nothing was sent.");
  }
  // The approve sheet shows what the engine reports, the entries' own spend (get_FullSpend). A
  // stored ceiling is not part of it, yet when a dependent call misses its block the core re-runs
  // the stored app body and signs any variant that spends up to the ceiling, without asking again
  // (contract_transaction.cpp IsSpendWithinLimits, RebuildHft). Without one it holds a rebuild to
  // 1% over what was approved. No BEAM shader sets a ceiling (Env::SetMaxSpend is used nowhere in
  // bvm/Shaders; BEAM's DEX trades rely on the 1%), so none is accepted from a dApp.
  if (data.spendMax !== null || data.entries.some((e) => e.flags & FLAG_SAVE_SPEND_MAX)) {
    throw new PolicyRefusal('spend_ceiling', 'BEAM Campfire refused this request: it asks for permission to spend more later than it shows you now. Nothing was sent.');
  }
  for (const e of data.entries) {
    // Without confirm_comment the approve sheet shows these comments, which the dApp wrote.
    if (hasHiddenText(e.comment)) {
      throw new PolicyRefusal('hidden_text', "BEAM Campfire refused this request: its description contains hidden characters that could change how it reads. Nothing was sent.");
    }
    if (e.contractId && FORBIDDEN_CONTRACTS.has(e.contractId)) {
      throw new PolicyRefusal('forbidden_contract', `BEAM Campfire refused this request: it calls ${KNOWN_CONTRACTS[e.contractId]}, which holds your names and the payments sent to them. Nothing was sent.`);
    }
    for (const k of e.signatureKeyHashes) {
      const use = RESERVED_KEYS[k.toLowerCase()];
      if (use) throw new PolicyRefusal('reserved_key', `BEAM Campfire refused this request: it signs with the key that controls ${use}. Nothing was sent.`);
    }
  }
  return data;
}

const REBUILD_REFUSED = "BEAM Campfire refused this request: it lets the dApp's own code redo the call later, without asking you again. BEAM Campfire allows that only for code from BEAM's own dApps. Nothing was sent.";
const REBUILD_ARGS_REFUSED = "BEAM Campfire refused this request: it lets BEAM's dApp code redo the call later on another contract than the one that code is made for. Nothing was sent.";

/**
 * Why the arguments stored next to a pinned body may not be redone (audit BC-4), or null. The core
 * re-runs the body with exactly these arguments, so every contract argument in them (a key that
 * starts with "cid", spaces around it ignored) must be one the pin lists, naming a contract it
 * lists for it, and "cid" must be there.
 * @param {object|null} args the stored arguments, key -> value
 * @param {object|null} contracts the pin's {argument: [contract ids]}
 */
export function storedArgsProblem(args, contracts) {
  if (!args || typeof args !== 'object') return 'no stored arguments';
  if (!contracts || typeof contracts !== 'object') return 'this code names no contract';
  let named = false;
  for (const [k, v] of Object.entries(args)) {
    const key = String(k).trim();
    if (!/^cid/i.test(key)) continue;
    const allowed = Object.prototype.hasOwnProperty.call(contracts, key) ? contracts[key] : null;
    if (!allowed) return `${key} is not a contract this code is redone with`;
    if (!allowed.includes(String(v).trim().toLowerCase())) return `${key} names another contract`;
    if (key === 'cid') named = true;
  }
  return named ? null : 'no contract named';
}

/**
 * Throws PolicyRefusal when data the core could redo later (a dependent call, or a stored app
 * body) does not store a body from REBUILD_BODIES. When a dependent call misses its block the
 * core re-runs the stored body and signs what it emits without asking again
 * (contract_transaction.cpp RebuildHft); nothing checks that variant against these rules, only
 * its funds against the approved ones (1%). Unknown code could then call BEAM names, or sign
 * with a key above. unchecked: a dApp installed from a file, refused whatever it stores.
 */
export async function checkRebuild(data, { unchecked }) {
  const later = data.appShader !== null || data.entries.some((e) => e.flags & (FLAG_DEPENDENT | FLAG_SAVE_APP_INVOKE));
  if (!later) return;
  // A stored contract body is code the rebuild could deploy: no dApp of BEAM's stores one.
  if (unchecked !== false || !data.appShader || data.contractShaderLength !== 0) throw new PolicyRefusal('rebuild', REBUILD_REFUSED);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data.appShader));
  const hex = Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
  if (!Object.prototype.hasOwnProperty.call(REBUILD_BODIES, hex)) throw new PolicyRefusal('rebuild', REBUILD_REFUSED);
  // The body is known; the arguments it would be re-run with must be for its own contract (BC-4).
  if (storedArgsProblem(data.appArgs, REBUILD_BODIES[hex].contracts)) throw new PolicyRefusal('rebuild', REBUILD_ARGS_REFUSED);
}

/** SHA-256("bvm.m.key\0" || keyMaterialBytes), lowercase hex. */
export async function keyHashOf(keyMaterialHex) {
  const id = new Uint8Array(keyMaterialHex.length / 2);
  for (let i = 0; i < id.length; i++) id[i] = parseInt(keyMaterialHex.slice(i * 2, i * 2 + 2), 16);
  const pre = new Uint8Array(10 + id.length);
  pre.set(new TextEncoder().encode('bvm.m.key'), 0);
  pre[9] = 0;
  pre.set(id, 10);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', pre));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** What the reserved key derived from sign_message's key_material controls, or null. */
export async function reservedUseOfKeyMaterial(keyMaterialHex) {
  return RESERVED_KEYS[await keyHashOf(keyMaterialHex)] || null;
}

export function refusalError(e) {
  return new RpcError(RPC.notAllowed, e.message);
}
