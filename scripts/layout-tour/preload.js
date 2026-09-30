// Stubbed window.api for the layout tour: every call goes to data.js in the tour's main process (no Supabase, no
// login, nothing written). Event subscriptions (on*) are no-ops that return an unsubscribe.
const { ipcRenderer } = require('electron');
const call = (name, args) => ipcRenderer.invoke('stub', name, args);
window.api = new Proxy({}, { get: (_, name) => {
  if (typeof name !== 'string') return undefined;
  if (name.startsWith('on')) return () => () => {};
  return (...args) => call(name, args);
} });
