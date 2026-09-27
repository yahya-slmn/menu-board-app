'use strict';

/**
 * Install a Mac update without Squirrel.Mac.
 *
 * CI ships unsigned builds (CSC_IDENTITY_AUTO_DISCOVERY=false). Electron's
 * Squirrel.Mac updater quietly no-ops quitAndInstall() for those — the
 * "Restart Now" button appears to do nothing and the app stays on the old
 * version forever. electron-updater still downloads the zip fine; this module
 * replaces the running .app with ditto and relaunches.
 */

const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getRunningAppBundlePath() {
  // process.execPath = .../Menu Board.app/Contents/MacOS/Menu Board
  return path.resolve(process.execPath, '..', '..', '..');
}

/**
 * Spawn a detached installer that waits for this process to exit, then swaps
 * the .app and relaunches.
 *
 * @param {string} zipPath absolute path to the downloaded *-mac.zip
 * @param {{ info?: Function, error?: Function }} logger electron-log-like
 * @param {{ exitApp?: boolean }} opts when exitApp is true (default), calls app.exit(0)
 *   after spawning. Pass false from a before-quit handler (app is already quitting).
 */
function installMacUpdateFromZip(zipPath, logger = console, { exitApp = true } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('installMacUpdateFromZip is macOS-only');
  }
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`Update zip not found: ${zipPath || '(empty)'}`);
  }

  const appBundle = getRunningAppBundlePath();
  if (!appBundle.endsWith('.app')) {
    throw new Error(`Not running from a .app bundle (execPath=${process.execPath})`);
  }

  // Refuse to "update" a copy still sitting on a mounted DMG / read-only volume.
  try {
    fs.accessSync(path.dirname(appBundle), fs.constants.W_OK);
  } catch {
    throw new Error(
      `Cannot write to ${path.dirname(appBundle)}. Move Menu Board to /Applications and try again.`
    );
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-board-upd-'));
  const scriptPath = path.join(os.tmpdir(), `menu-board-install-${process.pid}.sh`);
  const logFile = path.join(os.tmpdir(), `menu-board-install-${process.pid}.log`);

  // Quote every path for the shell. Wait until our PID is gone, unzip, ditto
  // over the live bundle, clear quarantine (unsigned CI builds), relaunch.
  const script = `#!/bin/bash
set -euo pipefail
exec >${JSON.stringify(logFile)} 2>&1
ZIP=${JSON.stringify(zipPath)}
EXTRACT=${JSON.stringify(extractDir)}
APP_DEST=${JSON.stringify(appBundle)}
PID=${process.pid}

echo "waiting for pid $PID to exit"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
sleep 0.5

echo "extracting $ZIP"
rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
unzip -qo "$ZIP" -d "$EXTRACT"

NEW_APP=$(find "$EXTRACT" -name "*.app" -type d -print -quit)
if [ -z "\${NEW_APP}" ] || [ ! -d "\${NEW_APP}" ]; then
  echo "No .app found inside update zip" >&2
  exit 1
fi
echo "replacing $APP_DEST with $NEW_APP"

rm -rf "$APP_DEST"
ditto "$NEW_APP" "$APP_DEST"
xattr -cr "$APP_DEST" || true

echo "relaunching"
open "$APP_DEST"
rm -rf "$EXTRACT"
rm -f "$0"
echo "done"
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  logger.info?.(`[auto-updater] mac manual install: zip=${zipPath} dest=${appBundle} script=${scriptPath}`);

  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Hard exit so the shell can replace the bundle; app.quit() can hang on Mac
  // when windows/dialogs are still draining.
  if (exitApp) app.exit(0);
}

module.exports = { installMacUpdateFromZip, getRunningAppBundlePath };
