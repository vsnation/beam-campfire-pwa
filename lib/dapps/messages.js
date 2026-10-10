// The messages between a dApp frame and the wallet.
//
// Nothing travels over window.postMessage after the first load: the wallet
// hands the frame a MessagePort exactly once, on the frame's first load,
// addressed to that frame's window, and from then on listens only to that
// port. A page in another frame, or the dApp posting to the wallet's
// window, reaches no listener. What arrives on the port is still checked
// here: a known type, the fields it needs, sizes bounded. Anything else is
// dropped without an answer.
//
// frame -> wallet
//   ready                          bootstrap is listening on the port
//   started                        the dApp's page has been written
//   rpc       {json}               one JSON-RPC request string
//   hello     {apiver, apivermin, appname}   web-extension handshake
//   pong      {n}
//   activity                       the person touched the dApp (auto-lock)
//   open-link {url}                the dApp wants to open an https link
//   layout    {width, viewport}    how wide the dApp's page is laid out
//   failed    {message}            the bootstrap could not start the dApp
// wallet -> frame
//   campfire-port (window message, first load only, with the port)
//   start  {files, start, shape, ua, style, hostCss, shims}
//   deliver {json}                 a JSON-RPC response or event
//   handshake {ok}
//   ping {n}

export const MAX_RPC_CHARS = 8 * 1024 * 1024;
const SHORT = 64;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortString = (v) => (typeof v === 'string' && v.length <= SHORT ? v : null);

/** A validated copy of a message from a dApp frame, or null. */
export function validateFrameMessage(m) {
  if (!isObj(m) || typeof m.t !== 'string') return null;
  switch (m.t) {
    case 'ready':
    case 'started':
    case 'activity':
      return { t: m.t };
    case 'rpc':
      if (typeof m.json !== 'string' || m.json.length === 0 || m.json.length > MAX_RPC_CHARS) return null;
      return { t: 'rpc', json: m.json };
    case 'hello':
      return { t: 'hello', apiver: shortString(m.apiver), apivermin: shortString(m.apivermin), appname: shortString(m.appname) };
    case 'pong':
      return Number.isSafeInteger(m.n) ? { t: 'pong', n: m.n } : null;
    case 'open-link': {
      if (typeof m.url !== 'string' || m.url.length > 2048) return null;
      let u;
      try {
        u = new URL(m.url);
      } catch {
        return null;
      }
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      return { t: 'open-link', url: u.href };
    }
    case 'layout':
      return Number.isSafeInteger(m.width) && Number.isSafeInteger(m.viewport) && m.width >= 0 && m.viewport >= 0 ? { t: 'layout', width: m.width, viewport: m.viewport } : null;
    case 'failed':
      return { t: 'failed', message: typeof m.message === 'string' ? m.message.slice(0, 300) : 'unknown' };
    default:
      return null;
  }
}
