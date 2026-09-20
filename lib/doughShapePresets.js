// Chef-configurable dough shape presets for Recipe on Fire's Shape & Place: a name, a real weight and
// the numbers the game builds a piece from (geometry type, size, taper, slashes). Rows live in
// `dough_shapes` (see supabase/migrations/20260920100000_dough_shape_presets.sql). Pure helpers over
// Supabase, like lib/recipeGenerator.js -- main.js only wires them to IPC.
const { supabase, supaFail } = require('./supabaseClient');

const ARCHETYPES = ['ball', 'disc', 'log', 'oval'];
const COLUMNS = 'id, name, unit_weight_grams, archetype, length_cm, width_cm, height_cm, taper, score_count, sort_order';

// The migration adds the columns this reads. Until it has been applied, PostgREST answers with
// "column does not exist" (42703) or "not found in the schema cache" (PGRST204/PGRST200-class).
function isMissingColumn(error) {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  return /archetype|archived|score_count/.test(error.message || '') && /column|schema cache/i.test(error.message || '');
}

async function listPresets() {
  const { data, error } = await supabase
    .from('dough_shapes').select(COLUMNS)
    .not('archetype', 'is', null).eq('archived', false)
    .order('sort_order').order('name');
  if (error) {
    if (isMissingColumn(error)) return { available: false, shapes: [] };
    throw supaFail('list-dough-shape-presets', error);
  }
  return { available: true, shapes: data };
}

const num = (v) => (v === '' || v == null ? NaN : Number(v));

// Returns { row } ready for the table, or { error } with a message fit to show the chef.
function validate(input) {
  const name = String(input?.name ?? '').trim();
  if (!name) return { error: 'Give the shape a name.' };
  if (name.length > 60) return { error: 'The name is too long (60 characters at most).' };
  const archetype = input.archetype;
  if (!ARCHETYPES.includes(archetype)) return { error: 'Pick a type.' };

  const inRange = (label, v, lo, hi, unit) => (Number.isFinite(v) && v >= lo && v <= hi ? null : `${label} must be between ${lo} and ${hi}${unit}.`);
  const weight = num(input.weight), length = num(input.lengthCm), height = num(input.heightCm);
  let width = num(input.widthCm);
  const round = archetype === 'ball' || archetype === 'disc';
  if (round) width = length; // a ball / disc is one diameter
  const problem = inRange('Weight', weight, 5, 5000, ' g')
    || inRange(round ? 'Diameter' : 'Length', length, 2, 120, ' cm')
    || (round ? null : inRange('Width', width, 1, 60, ' cm'))
    || inRange('Height', height, 0.5, 20, ' cm');
  if (problem) return { error: problem };

  let taper = 0, scoreCount = 0;
  if (archetype === 'log') {
    const t = num(input.taper);
    taper = Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0.8;
  }
  if (archetype === 'log' || archetype === 'oval') {
    const sc = num(input.scoreCount);
    scoreCount = Number.isFinite(sc) ? Math.min(Math.max(Math.round(sc), 0), 9) : 0;
  }
  const r = (v) => Math.round(v * 100) / 100;
  return { row: {
    name, archetype,
    unit_weight_grams: r(weight),
    size_cm: r(length),                 // the older column the Dough Shapes screen reads: the longest dimension
    length_cm: r(length), width_cm: r(width), height_cm: r(height),
    taper: r(taper), score_count: scoreCount,
  } };
}

async function savePreset(input) {
  const v = validate(input);
  if (v.error) return { success: false, error: v.error };
  const row = { ...v.row, archived: false };
  const cols = COLUMNS;

  if (input.id) {
    const { data, error } = await supabase.from('dough_shapes').update(row).eq('id', input.id).select(cols).single();
    if (error) {
      if (error.code === '23505') return { success: false, error: `A shape named "${row.name}" already exists.` };
      if (isMissingColumn(error)) return { success: false, error: 'The database update for shapes has not been applied yet.' };
      throw supaFail('save-dough-shape-preset (update)', error);
    }
    return { success: true, shape: data };
  }

  const { data, error } = await supabase.from('dough_shapes').insert({ ...row, sort_order: 100 }).select(cols).single();
  if (!error) return { success: true, shape: data };
  if (isMissingColumn(error)) return { success: false, error: 'The database update for shapes has not been applied yet.' };
  if (error.code !== '23505') throw supaFail('save-dough-shape-preset (insert)', error);

  // The name is taken. If it belongs to a shape that was "deleted" (archived), bring that row back with
  // the new values -- names are unique and a real delete would cascade away legacy photo rows.
  const { data: existing, error: findErr } = await supabase.from('dough_shapes').select('id, archived').eq('name', row.name).maybeSingle();
  if (findErr) throw supaFail('save-dough-shape-preset (find)', findErr);
  if (!existing || !existing.archived) return { success: false, error: `A shape named "${row.name}" already exists.` };
  const { data: revived, error: revErr } = await supabase.from('dough_shapes').update(row).eq('id', existing.id).select(cols).single();
  if (revErr) throw supaFail('save-dough-shape-preset (revive)', revErr);
  return { success: true, shape: revived };
}

// Archives (hides) the shape; the row itself stays.
async function deletePreset(id) {
  const { error } = await supabase.from('dough_shapes').update({ archived: true }).eq('id', id);
  if (error) throw supaFail('delete-dough-shape-preset', error);
  return { success: true };
}

module.exports = { listPresets, savePreset, deletePreset, validate, isMissingColumn, ARCHETYPES };
