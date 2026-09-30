#!/usr/bin/env node
// Layout tour: walks Dish Catalog, Menu Planner (Generate + every Build Menu section grid), Recipe Generator (a draft
// folder and Recipe Generated) and Recipe on Fire (Setup, Shape & Place, Sheet & Trim, layers, Batch, One dough) in the
// real renderer, at a Mac-like size (overlay scrollbars)
// and a Windows-like size (17px classic scrollbars), and fails (exit 1) when:
//   - any screen scrolls sideways: #main, the page, or any scroll container inside it (a table's .table-scroll...);
//   - a Recipe on Fire step needs vertical scrolling at the Mac size (CLAUDE.md: that screen never scrolls);
//   - a step could not be reached (the tour itself broke -- fix the step, not the check).
// Windows' vertical fit is reported, not failed: its height is an estimate and a known separate issue.
//
//   npm run tour                      # both configurations
//   node scripts/layout-tour/run.js --config win
//   node scripts/layout-tour/run.js --css "table.items-table.dish-catalog-table{min-width:960px!important}"
//                                     # a control run: put an old rule back, the tour should now fail
//
// Read-only: window.api is stubbed (data.js), so it needs no login and never touches Supabase or backups/.
// Screenshots go to a new temp directory (printed at the end), or --shots <dir>.
// It is Chromium's layout with a simulated scrollbar, not Windows itself: fonts, DPI scaling and the real frame
// size still need a look on the laptop.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron'); // the binary's path when required from Node

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const configs = opt('--config') ? [opt('--config')] : ['mac', 'win'];
const shots = opt('--shots') || fs.mkdtempSync(path.join(os.tmpdir(), 'menu-board-layout-tour-'));
fs.mkdirSync(shots, { recursive: true });

const failures = [];
for (const config of configs) {
  const run = spawnSync(electron, [path.join(__dirname, 'electron-main.js')], {
    env: { ...process.env, TOUR_CONFIG: config, TOUR_SHOTS: shots, TOUR_CSS: opt('--css') || '' },
    encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  const line = (run.stdout || '').split('\n').find(l => l.startsWith('TOUR_RESULT '));
  if (!line) {
    failures.push(`${config}: the tour did not finish (exit ${run.status}${run.signal ? ', ' + run.signal : ''})`);
    console.error((run.stderr || '').split('\n').filter(l => !/Warning|DevTools|mach_port|shared_memory|^\s*$/.test(l)).slice(-15).join('\n'));
    continue;
  }
  const { width, height, results, consoleErrors } = JSON.parse(line.slice('TOUR_RESULT '.length));
  console.log(`\n${config} (${width} x ${height} content${config === 'win' ? ', 17px classic scrollbars' : ', overlay scrollbars'})`);
  for (const r of results) {
    const problems = [];
    if (r.error) problems.push(`step failed: ${r.error}`);
    else {
      if (r.hOverflowMain > 0) problems.push(`#main scrolls sideways by ${r.hOverflowMain}px`);
      if (r.docH > 0) problems.push(`the page scrolls sideways by ${r.docH}px`);
      for (const s of r.hScrollers) problems.push(`${s}px sideways`);
      if (r.group === 'rof' && config === 'mac' && r.vOverflowMain > 0) problems.push(`needs ${r.vOverflowMain}px of vertical scrolling`);
    }
    const note = !r.error && r.group === 'rof' && config !== 'mac' && r.vOverflowMain > 0 ? ` (vertical: ${r.vOverflowMain}px, reported only)` : '';
    const size = r.error ? '' : `  main ${r.mainW}px${r.vbar ? `, scrollbar ${r.vbar}px` : ''}`;
    console.log(`  ${problems.length ? 'FAIL' : 'ok  '}  ${r.label.padEnd(36)}${size}${note}${problems.length ? '\n        ' + problems.join('\n        ') : ''}`);
    for (const p of problems) failures.push(`${config} / ${r.label}: ${p}`);
  }
  if (consoleErrors.length) console.log(`  console errors (not failed):\n    ${[...new Set(consoleErrors)].slice(0, 10).join('\n    ')}`);
}

console.log(`\nScreenshots: ${shots}`);
if (failures.length) {
  console.log(`\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll steps fit.');
