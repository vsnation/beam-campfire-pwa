// The chains buybeam.my names that are Ethereum-style (0x addresses), on their own: the buy list
// needs them on Home's first screen, the address checks (deposit_address.js, with its hash code)
// only once an order is made.
export const EVM_CHAINS = Object.freeze(new Set(['eth', 'arb', 'base', 'op', 'bsc', 'pol', 'avax', 'gnosis', 'scroll', 'bera', 'monad', 'xlayer', 'plasma', 'abs']));
