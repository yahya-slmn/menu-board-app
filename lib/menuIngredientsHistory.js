// ============================================================
// Menu Ingredients history (2026-10-06): every generation is saved so the chef can reopen, edit and export it later from the
// same screen (History tab). Migration 20261006100000 (menu_ingredient_runs + menu_ingredient_run_files), applied by hand.
// History NEVER writes to the Dish Catalog (M2 / M3 are separate and unchanged).
//
// One entry = one upload (its files can share "Same as" links). Stored: who / when, the file names, the review exactly as the
// screen holds it (state.menuIngredients.files: per file its rows -- section, category, day, row position, dish, ingredients,
// allergens, basis, removal notes, catalog note, "Same as" links, served-as-is rows), gzip-compressed JSON in base64, and the
// ORIGINAL workbook(s): export edits the original file, so it is kept.
//
// Edits are saved only if the entry is still the version the editor opened (compare-and-swap on `version` in the UPDATE
// itself): nobody overwrites anyone else's edits. The database is passed in (main.js passes Supabase; the check a stand-in).
// ============================================================
const zlib = require('zlib');

const DATA_FORMAT = 1;
const FILE_COLUMNS = 'run_id, file_index, file_name, content_b64, byte_size';
const LIST_COLUMNS = 'id, created_at, created_by, file_names, row_count, failed_files, complete, version, updated_at, updated_by';

const fail = (context, error) => new Error(`${context}: ${error?.message || String(error)}`);

// The review (an array of files, each { fileIndex, fileName, success, rows, failures } or a failed one) <-> rows_gz.
function encodeReview(files) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(files), 'utf8')).toString('base64');
}
function decodeReview(rowsGz) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(rowsGz, 'base64')).toString('utf8'));
}
const rowCount = (files) => (files || []).reduce((n, f) => n + ((f && f.rows) ? f.rows.length : 0), 0);

async function historyAvailable(db) {
  const { error } = await db.from('menu_ingredient_runs').select('id').limit(1);
  return !error;
}

// A new entry: the review, then the original files, then `complete`. originals: [{ fileIndex, fileName, base64 }].
// -> { id, version: 1, complete } ; a failed file save leaves complete false (listed as incomplete) and is reported.
async function createRun(db, { who, files, originals }) {
  const ok = (files || []).filter((f) => f && f.success);
  const failed = (files || []).filter((f) => f && !f.success).map((f) => ({ fileName: f.fileName, error: f.error || null }));
  const { data, error } = await db.from('menu_ingredient_runs').insert({
    created_by: who || null, updated_by: who || null,
    file_names: ok.map((f) => f.fileName), row_count: rowCount(ok), failed_files: failed.length ? failed : null,
    rows_gz: encodeReview(files), data_format: DATA_FORMAT,
  }).select('id, version').single();
  if (error) throw fail('save the history entry', error);
  const keep = (originals || []).filter((o) => ok.some((f) => f.fileIndex === o.fileIndex));
  const rows = keep.map((o) => ({ run_id: data.id, file_index: o.fileIndex, file_name: o.fileName, content_b64: o.base64, byte_size: Buffer.from(o.base64, 'base64').length }));
  for (const r of rows) {
    const { error: fErr } = await db.from('menu_ingredient_run_files').insert(r);
    if (fErr) return { id: data.id, version: data.version, complete: false, error: `the original file "${r.file_name}" couldn't be saved: ${fErr.message || fErr}` };
  }
  const { error: cErr } = await db.from('menu_ingredient_runs').update({ complete: true }).eq('id', data.id);
  if (cErr) return { id: data.id, version: data.version, complete: false, error: `couldn't mark the entry complete: ${cErr.message || cErr}` };
  return { id: data.id, version: data.version, complete: true };
}

// The list: light columns only (never the review or the files), newest first.
async function listRuns(db, { limit = 300 } = {}) {
  const { data, error } = await db.from('menu_ingredient_runs').select(LIST_COLUMNS).order('created_at', { ascending: false }).limit(limit);
  if (error) throw fail('load the history', error);
  return data || [];
}

// One entry in full: its meta, the review, and the original files (base64). -> null when it no longer exists.
async function loadRun(db, id) {
  const { data: run, error } = await db.from('menu_ingredient_runs').select(`${LIST_COLUMNS}, rows_gz, data_format`).eq('id', id).maybeSingle();
  if (error) throw fail('open the history entry', error);
  if (!run) return null;
  const { data: files, error: fErr } = await db.from('menu_ingredient_run_files').select(FILE_COLUMNS).eq('run_id', id).order('file_index');
  if (fErr) throw fail('load the original files', fErr);
  const { rows_gz, ...meta } = run;
  return { meta, review: decodeReview(rows_gz), originals: (files || []).map((f) => ({ fileIndex: f.file_index, fileName: f.file_name, base64: f.content_b64 })) };
}

// Saves edits only if the entry is still at expectedVersion. -> { saved: true, version, updatedAt } | { conflict: { by, at,
// version } } (someone else saved since it was opened -- nothing written) | { gone: true } (deleted meanwhile).
async function saveRunEdits(db, { id, expectedVersion, files, who }) {
  const at = new Date().toISOString();
  const { data, error } = await db.from('menu_ingredient_runs')
    .update({ rows_gz: encodeReview(files), row_count: rowCount((files || []).filter((f) => f && f.success)), version: expectedVersion + 1, updated_at: at, updated_by: who || null })
    .eq('id', id).eq('version', expectedVersion).select('id, version, updated_at');
  if (error) throw fail('save the edits', error);
  if (data && data.length) return { saved: true, version: data[0].version, updatedAt: data[0].updated_at };
  const { data: now, error: nErr } = await db.from('menu_ingredient_runs').select('version, updated_at, updated_by').eq('id', id).maybeSingle();
  if (nErr) throw fail('check the history entry', nErr);
  if (!now) return { gone: true };
  return { conflict: { by: now.updated_by || null, at: now.updated_at || null, version: now.version } };
}

// "Save mine as a new history entry" after a conflict: a new entry with this review and the SAME original files.
async function saveRunAsNew(db, { fromId, files, who }) {
  const src = await loadRun(db, fromId);
  if (!src) throw new Error('The original history entry no longer exists, so its files can\'t be copied.');
  return createRun(db, { who, files, originals: src.originals });
}

async function deleteRun(db, id) {
  const { data, error } = await db.from('menu_ingredient_runs').delete().eq('id', id).select('id');
  if (error) throw fail('delete the history entry', error);
  return { deleted: (data || []).length };
}

module.exports = { DATA_FORMAT, encodeReview, decodeReview, rowCount, historyAvailable, createRun, listRuns, loadRun, saveRunEdits, saveRunAsNew, deleteRun };
