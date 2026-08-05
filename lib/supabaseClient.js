const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const SUPABASE_URL = 'https://qulbbwdffcttuabyscnb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_zsxPm3C5-FWkS-jzBCF_FQ_aUQYpvNb';

// Runs in the main process, not a browser -- there's no localStorage to persist a
// session into, so persistSession/autoRefreshToken (which assume one) are disabled.
// realtime.transport is supplied explicitly because Electron's main process runs on
// a Node version without a global WebSocket, which the realtime client requires even
// though this app doesn't use realtime subscriptions.
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});

// Electron's ipcMain.handle only reconstructs a proper Error on the renderer side when the
// thrown value's own .message is a real string; anything else renders as "[object Object]"
// in the renderer console with no way to see what actually went wrong. Every Supabase call
// site across main.js/lib wraps its error through this so (a) the real Postgrest/network
// failure -- message, code, details, hint -- is always logged here in the main-process
// terminal, and (b) the renderer always gets back a proper Error with a readable message.
function supaFail(context, error) {
  console.error(`[supabase] ${context} failed:`, {
    message: error?.message, code: error?.code, details: error?.details, hint: error?.hint, raw: error,
  });
  const message = (error && error.message) || (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  const wrapped = new Error(`${context}: ${message}`);
  if (error?.code) wrapped.code = error.code;
  return wrapped;
}

module.exports = { supabase, supaFail };
