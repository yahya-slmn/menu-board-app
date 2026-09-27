#!/usr/bin/env node
// Live round trip of the shared density cache (phase D2; needs the density_estimates table and the estimate-density
// function). Signs in, then estimates one fixed mass three times through the app's own cached path:
//   1. first time   -> an AI call, and a row saved to density_estimates
//   2. same mass    -> answered from the cache, no AI call
//   3. same mass scaled x3 (as the Batch Calculator would) -> still answered from the cache
// Writes at most ONE cache row (a real, reusable estimate); touches no recipe. Costs at most one paid call.
//
//   cd ~/menu-board && node scripts/density-cache-check.js
//
// Asks for your login (run it in a normal Terminal window).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');
const { estimateDensity, toDensityItem } = require('../lib/estimateDensity');
const { estimateDensityCached } = require('../lib/densityCache');
const { densityCacheKey } = require('../lib/densityKey');

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
  return src.match(/LOGIN_ID_DOMAIN\s*=\s*['"`]([^'"`]+)['"`]/)[1];
}

const ROWS = [{ name: 'Feta cheese', quantity: 300, unit: 'GR' }, { name: 'Mozzarella, grated', quantity: 200, unit: 'GR' }, { name: 'Eggs', quantity: 150, unit: 'GR' }, { name: 'Milk', quantity: 100, unit: 'GR' }];
const METHOD = 'Mix everything together.';
const mass = (factor) => toDensityItem({ index: 0, label: 'Cache check: cheese and egg filling', role: 'filling', sources: [{ rows: ROWS.map(r => ({ ...r, quantity: r.quantity * factor })), method: METHOD }] });

(async () => {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error: authError } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (authError) { console.error('Sign-in failed:', authError.message); process.exit(1); }

  let aiCalls = 0;
  const countingEstimate = async (items) => { aiCalls += 1; return estimateDensity(items); };
  const key = densityCacheKey(mass(1));
  const { data: before } = await supabase.from('density_estimates').select('cache_key').eq('cache_key', key);
  console.log(`Cache key: ${key.slice(0, 16)}...  (${before?.length ? 'already in the cache from an earlier run' : 'not in the cache yet'})`);

  const steps = [['1. first time', 1], ['2. same mass again', 1], ['3. same mass scaled x3', 3]];
  let ok = true;
  for (const [label, factor] of steps) {
    const callsBefore = aiCalls;
    const r = await estimateDensityCached([mass(factor)], { db: supabase, estimate: countingEstimate });
    const e = r.estimates.get(0);
    const fromCache = r.cached.includes(0);
    console.log(`${label}: ${e ? `${e.density} g/cm3 (${e.low}-${e.high}, ${e.confidence})` : 'NO ANSWER'} -- ${fromCache ? 'from the cache' : 'AI call'}${aiCalls > callsBefore ? '' : ', no AI call'}${r.saveError ? ` -- SAVE FAILED: ${r.saveError}` : ''}${r.cacheError ? ` -- CACHE NOT READ: ${r.cacheError}` : ''}`);
    if (label.startsWith('2') || label.startsWith('3')) ok = ok && fromCache && aiCalls === callsBefore;
    if (!e) ok = false;
  }
  const { data: after, error } = await supabase.from('density_estimates').select('cache_key, prompt_version, density, confidence, label, created_at').eq('cache_key', key);
  if (error) { console.log(`Reading the row back failed: ${error.message}`); ok = false; }
  else console.log(`Row in density_estimates: ${after.length ? JSON.stringify(after[0]) : 'NONE'}`);
  if (!after?.length) ok = false;
  console.log(ok ? '\nPASS: saved once, then reused (including the scaled copy) with no further AI calls.' : '\nFAIL: see the lines above.');
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
