// The token screens (Create a token, My tokens, a token's page, Mint more, Burn tokens), registered
// in app.js in one line. Their shared parts and the Tokens menu are in ./minter.js.
import minterCreate from './minter_create.js';
import minterTokens from './minter_tokens.js';
import minterToken from './minter_token.js';
import minterMint from './minter_mint.js';
import burn from './burn.js';

export const MINTER_SCREENS = { minterCreate, minterTokens, minterToken, minterMint, burn };
