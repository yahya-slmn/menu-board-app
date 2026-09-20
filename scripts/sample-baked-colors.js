#!/usr/bin/env node
// Colour calibration helper for the Recipe on Fire dough. Reads the Dough Shapes photos saved by
// scripts/backup-dough-photos.js and prints the colours they actually contain, so BAKE_COLORS in
// renderer/rof/dough.js can be tuned against real reference instead of by eye.
//
//   node scripts/sample-baked-colors.js
//
// For each shape and stage it samples the opaque pixels (the photos are cut out on transparency) and
// reports the darkest-15% / median / lightest-15% colours as hex. Rough mapping to the ramp:
//   raw photos    -> BAKE_COLORS.raw          baked photos -> lightest ~ gold, darkest ~ deep
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const ROOT = path.join(__dirname, '..', 'backups', 'dough-shapes');
const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

(async () => {
  if (!fs.existsSync(ROOT)) { console.error(`No backup at ${ROOT} -- run scripts/backup-dough-photos.js first.`); process.exit(1); }
  const all = {};
  for (const shape of fs.readdirSync(ROOT).filter(d => fs.statSync(path.join(ROOT, d)).isDirectory())) {
    for (const file of fs.readdirSync(path.join(ROOT, shape)).filter(f => /\.(png|jpe?g)$/i.test(f))) {
      const stage = file.split('-')[0];
      const img = await Jimp.read(path.join(ROOT, shape, file));
      const px = [];
      img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
        const d = this.bitmap.data;
        if (d[idx + 3] > 200) px.push([d[idx], d[idx + 1], d[idx + 2]]);
      });
      if (!px.length) continue;
      px.sort((a, b) => luma(...a) - luma(...b));
      const at = (q) => px[Math.min(px.length - 1, Math.floor(px.length * q))];
      (all[`${shape} / ${stage}`] ||= []).push({ p15: at(0.15), p50: at(0.5), p85: at(0.85) });
    }
  }
  for (const [key, list] of Object.entries(all).sort()) {
    const avg = (k) => [0, 1, 2].map(i => list.reduce((s, e) => s + e[k][i], 0) / list.length);
    console.log(`${key.padEnd(34)} dark ${hex(...avg('p15'))}   median ${hex(...avg('p50'))}   light ${hex(...avg('p85'))}   (${list.length} photos)`);
  }
})();
