// Whether the browser keeps this app's storage (wallet.db in IndexedDB, the
// verified copy in Cache Storage) or may clear it under pressure. Asked for once
// a wallet exists; the answer is shown in Settings -> About. No network.

export async function refreshPersistence(app, { request = false } = {}) {
  const s = navigator.storage;
  if (!s || typeof s.persisted !== 'function') {
    app.persisted = null;
    return null;
  }
  try {
    let kept = await s.persisted();
    if (!kept && request && typeof s.persist === 'function') kept = await s.persist();
    app.persisted = Boolean(kept);
  } catch {
    app.persisted = null;
  }
  return app.persisted;
}

export function persistenceText(persisted) {
  if (persisted === true) return 'kept';
  if (persisted === false) return 'may be cleared by the system';
  return 'unknown in this browser';
}
