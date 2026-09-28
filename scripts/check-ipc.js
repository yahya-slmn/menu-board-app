#!/usr/bin/env node
// Checks that every IPC channel the renderer can call has a handler in the main process.
//
// preload.js exposes window.api.* as ipcRenderer.invoke('<channel>') / ipcRenderer.send('<channel>'); main.js and lib/*.js
// answer with ipcMain.handle('<channel>') / ipcMain.on('<channel>'). A channel with no handler fails only when the
// renderer calls it ("No handler registered for '<channel>'"), so a deleted handler can ship unnoticed -- that is how
// History, dish swaps and several exports broke in v1.0.38-1.0.45. This script fails (exit 1) when:
//   - a preload channel has no handler, or
//   - a channel is registered twice (Electron throws at startup).
// Handlers with no preload channel are listed as a note only (they may be called another way).
//
//   node scripts/check-ipc.js
//
// Read-only: it reads the source files as text and never starts the app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const mainFiles = ['main.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => `lib/${f}`)];

const channels = (text, re) => [...text.matchAll(re)].map(m => m[1]);
const preload = read('preload.js');
const called = new Set(channels(preload, /ipcRenderer\.(?:invoke|send|sendSync)\(\s*['"`]([^'"`]+)['"`]/g));

const handled = new Map(); // channel -> [file, ...] (one entry per registration)
for (const file of mainFiles) {
  for (const ch of channels(read(file), /ipcMain\.(?:handle|handleOnce|on|once)\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!handled.has(ch)) handled.set(ch, []);
    handled.get(ch).push(file);
  }
}

const missing = [...called].filter(ch => !handled.has(ch)).sort();
const duplicated = [...handled].filter(([, files]) => files.length > 1).map(([ch, files]) => `${ch} (${files.join(', ')})`).sort();
const unused = [...handled.keys()].filter(ch => !called.has(ch)).sort();

console.log(`preload.js calls ${called.size} channel(s); the main process registers ${handled.size}.`);
if (missing.length) console.log(`\nNO HANDLER for ${missing.length} channel(s) preload.js calls:\n  ${missing.join('\n  ')}`);
if (duplicated.length) console.log(`\nREGISTERED MORE THAN ONCE (Electron throws at startup):\n  ${duplicated.join('\n  ')}`);
if (unused.length) console.log(`\nNote: handler(s) with no preload.js channel (not an error):\n  ${unused.join('\n  ')}`);
const ok = !missing.length && !duplicated.length;
console.log(ok ? '\nOK: every preload channel has exactly one handler.' : '\nFAIL');
process.exit(ok ? 0 : 1);
