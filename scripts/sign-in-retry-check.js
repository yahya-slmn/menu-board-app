// The sign-in retry (lib/retryOnce.js, 2026-10-06): loading the reference lists right after sign-in is retried ONCE,
// after 1 s, when it fails with PGRST303 "JWT issued at future"; any other error, or a second failure, is thrown
// unchanged. No login, no network, no real waiting (the wait is passed in).   node scripts/sign-in-retry-check.js
const fs = require('fs');
const path = require('path');
const { retryOnce } = require('../lib/retryOnce');

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
}
const codedError = (code, message = code) => Object.assign(new Error(message), { code });

// A step that fails with the given errors in turn, then returns 'lists'.
function step(...errors) {
  const s = { calls: 0 };
  s.fn = async () => { const e = errors[s.calls++]; if (e) throw e; return 'lists'; };
  return s;
}
function run(s) {
  const waits = [];
  const retried = [];
  const p = retryOnce(s.fn, { codes: ['PGRST303'], delayMs: 1000, sleep: async (ms) => { waits.push(ms); }, onRetry: (e) => retried.push(e.message) });
  return p.then((value) => ({ value, waits, retried }), (error) => ({ error, waits, retried }));
}

(async () => {
  let s = step(codedError('PGRST303', 'loadReferenceData: protein_types: JWT issued at future'));
  let r = await run(s);
  check('1 PGRST303 once, then fine: 2 calls, one 1000 ms wait, the lists returned, the retry reported',
    s.calls === 2 && r.value === 'lists' && JSON.stringify(r.waits) === '[1000]' && r.retried.length === 1, JSON.stringify({ calls: s.calls, r }));

  const second = codedError('PGRST303', 'second');
  s = step(codedError('PGRST303', 'first'), second);
  r = await run(s);
  check('2 PGRST303 twice: 2 calls, the SECOND error thrown unchanged', s.calls === 2 && r.error === second && r.waits.length === 1);

  for (const other of [codedError('42501', 'permission denied'), codedError(undefined, 'Invalid login credentials'),
    Object.assign(new Error('fetch failed'), { status: 0 }), codedError('PGRST301', 'JWT expired')]) {
    s = step(other);
    r = await run(s);
    check(`3 another error (${other.code || other.message}): 1 call, no wait, thrown unchanged`,
      s.calls === 1 && r.error === other && !r.waits.length && !r.retried.length);
  }

  s = step();
  r = await run(s);
  check('4 fine at once: 1 call, no wait', s.calls === 1 && r.value === 'lists' && !r.waits.length);

  s = step(null);
  const thrown = await retryOnce(async () => { throw null; }, { codes: ['PGRST303'], sleep: async () => {} }).then(() => 'resolved', (e) => e);
  check('5 a thrown non-Error is passed through, not retried', thrown === null);

  // The default wait is a real 1 s timer (short check: it waits at least ~1 s).
  let n = 0;
  const t0 = Date.now();
  await retryOnce(async () => { if (n++ === 0) throw codedError('PGRST303'); return 1; }, { codes: ['PGRST303'], delayMs: 1000 });
  check('6 the default wait really waits ~1 s', Date.now() - t0 >= 950, `${Date.now() - t0} ms`);

  // main.js wiring: the sign-in handler loads the reference lists through retryOnce, with PGRST303 and 1000 ms.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('auth-sign-in'");
  const end = main.indexOf('\n});', start);
  const handler = start >= 0 && end > start ? main.slice(start, end) : '';
  check('7 main.js imports retryOnce', /const \{ retryOnce \} = require\('\.\/lib\/retryOnce'\);/.test(main));
  check('8 auth-sign-in calls retryOnce(loadReferenceData, { codes: [\'PGRST303\'], delayMs: 1000 ...',
    /await retryOnce\(loadReferenceData, \{\s*codes: \['PGRST303'\],\s*delayMs: 1000,/.test(handler), handler ? '' : 'auth-sign-in handler not found');
  check('9 auth-sign-in never calls loadReferenceData() bare', !/loadReferenceData\(\)/.test(handler));

  console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed` : `Sign-in retry OK (${passes} checks).`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
