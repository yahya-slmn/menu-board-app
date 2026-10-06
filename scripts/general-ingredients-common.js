// Shared by general-ingredients-import.js and general-ingredients-verify.js: the login prompt and reading the table.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { supabase } = require('../lib/supabaseClient');

const DEFAULT_FILE = path.join(__dirname, '..', 'backups', 'kitchen-ingredients.xlsx');
const TABLE_COLUMNS = 'id, item_code, name, name_key, name_ar, parent_name, category, form, primary_department, item_type, storage, typical_uom, departments, created_at, created_by';

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
async function signIn() {
  const id = (await ask('Menu Board login ID: ')).trim().toLowerCase();
  const password = await ask('Password: ', { hidden: true });
  const { error } = await supabase.auth.signInWithPassword({ email: `${id}@${loginDomain()}`, password });
  if (error) { console.error('Sign-in failed:', error.message); process.exit(1); }
  return id;
}
// Every row of general_ingredients. Stops with a clear message when the table isn't there (migration not applied).
async function fetchTable() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('general_ingredients').select(TABLE_COLUMNS).order('id').range(from, from + 999);
    if (error) {
      if (error.code === 'PGRST205' || /does not exist|could not find/i.test(error.message)) {
        console.error('The general_ingredients table is not there: apply supabase/migrations/20261006110000_general_ingredients.sql first.');
        process.exit(1);
      }
      throw new Error(`general_ingredients: ${error.message}`);
    }
    all.push(...data);
    if (data.length < 1000) return all;
  }
}
// The Excel file: the first argument that isn't a --flag, else backups/kitchen-ingredients.xlsx.
function filePathFromArgs() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const p = arg ? path.resolve(arg) : DEFAULT_FILE;
  if (!fs.existsSync(p)) { console.error(`File not found: ${p}`); process.exit(1); }
  return p;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupsPath = (name) => path.join(__dirname, '..', 'backups', name);

module.exports = { supabase, ask, signIn, fetchTable, filePathFromArgs, stamp, backupsPath };
