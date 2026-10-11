// BEAM names' own screens beyond the Names screen itself (app.js spreads these into
// its registry; each needs an unlocked wallet).
import nameDetail from './name_detail.js';
import nameTransfer from './name_transfer.js';
import nameSell from './name_sell.js';
import nameKey from './name_key.js';

export const NAME_SCREENS = Object.freeze({ nameDetail, nameTransfer, nameSell, nameKey });
