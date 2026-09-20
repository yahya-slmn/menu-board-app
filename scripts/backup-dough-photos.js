#!/usr/bin/env node
// One-off backup of the Dough Shapes catalog (both tables + every reference photo) to
// backups/dough-shapes/, taken BEFORE that catalog is removed from Supabase. The photos are in a
// private bucket behind RLS, so this signs in as you -- run it yourself:
//
//   ! node scripts/backup-dough-photos.js
//
// It asks for your normal Menu Board login ID and password (the password prompt is hidden and is
// never written anywhere). Read-only: it lists rows and downloads files, nothing is changed or
// deleted. The results:
//   backups/dough-shapes/rows.json                  dough_shapes + dough_shape_photos rows
//   backups/dough-shapes/<shape>/<stage>-<n>.<ext>  every photo, named by shape/stage/variation
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// Same project + publishable key the app itself ships with (lib/supabaseClient.js), and the same
// "login ID -> email" mapping as main.js's auth-sign-in handler.
const SUPABASE_URL = 'https://qulbbwdffcttuabyscnb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_zsxPm3C5-FWkS-jzBCF_FQ_aUQYpvNb';
const BUCKET = 'dough-shape-photos';
const OUT = path.join(__dirname, '..', 'backups', 'dough-shapes');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n'); };
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function loginDomain() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const m = src.match(/LOGIN_ID_DOMAIN\s*=\s*['"`]([^'"`]+)['"`]/);
  if (!m) throw new Error("Couldn't find LOGIN_ID_DOMAIN in main.js");
  return m[1];
}

(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }

  const { data: shapes, error: e1 } = await supabase.from('dough_shapes').select('*').order('id');
  if (e1) throw e1;
  const { data: photos, error: e2 } = await supabase.from('dough_shape_photos').select('*').order('dough_shape_id').order('stage').order('variation_index');
  if (e2) throw e2;
  console.log(`Found ${shapes.length} shape(s) and ${photos.length} photo(s).`);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'rows.json'), JSON.stringify({ dough_shapes: shapes, dough_shape_photos: photos }, null, 2));

  let saved = 0;
  for (const p of photos) {
    const shape = shapes.find(s => s.id === p.dough_shape_id);
    const dir = path.join(OUT, (shape ? shape.name : `shape-${p.dough_shape_id}`).replace(/[^\w.-]+/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const { data, error } = await supabase.storage.from(BUCKET).download(p.photo_path);
    if (error) { console.error(`  FAILED ${p.photo_path}: ${error.message}`); continue; }
    const ext = path.extname(p.photo_path) || '.png';
    fs.writeFileSync(path.join(dir, `${p.stage}-${p.variation_index}${ext}`), Buffer.from(await data.arrayBuffer()));
    saved++;
  }
  console.log(`Saved ${saved} of ${photos.length} photo(s) to ${OUT}`);
  if (saved !== photos.length) { console.error('Some photos failed -- do NOT remove the catalog until every one is backed up.'); process.exit(2); }
})().catch((err) => { console.error(err); process.exit(1); });
