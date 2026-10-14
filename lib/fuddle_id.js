// Where Fuddle lives on chain: the one place its contract id is written.
//
// Fuddle v9 (the Fuddle repo's v9/, commit 8e86b3140) is built and audited but NOT deployed. Its
// contract id is only known once the owner deploys v9/contract.wasm: the id is
// SHA256("bvm.cid\0" | shader ID | varint(len) | constructor arguments), and the arguments carry the
// owner key, the answer service's key and the three dictionary roots. Until FUDDLE_CID is set, every
// Fuddle screen says "Fuddle opens soon" and nothing calls the contract (test/unit/fuddle.test.mjs
// asserts that gate).
//
// At deployment, set together:
//   FUDDLE_CID          the contract id (64 hex), also kFuddleContractId in
//                       lib/wallets/beam/contracts/fuddle/fuddle_constants.dart;
//   FUDDLE_SERVICE_PK   the BEAM Campfire answer service's key (`fuddle_service keys`, the
//                       answerer key the contract was deployed with), so the wallet can say which
//                       tournaments it answers;
//   lib/dapps/policy.js the player key {cid, 0} as a reserved key, so no dApp signs as the player
//                       (a unit test fails until it is there).
//
// This module stays tiny on purpose: lib/wallet.js (history labels) and the dApp policy import it
// without loading the game.

/** The Fuddle v9 contract id (64 lowercase hex), or null while it is not deployed. */
export const FUDDLE_CID = null;

/** The BEAM Campfire answer service's key (66 hex), or null until it is known. */
export const FUDDLE_SERVICE_PK = null;

/** Whether Fuddle can be played in this release. */
export const fuddleLive = (cid = FUDDLE_CID) => typeof cid === 'string' && /^[0-9a-f]{64}$/.test(cid);
