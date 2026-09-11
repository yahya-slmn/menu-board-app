-- Temporary read-only inspection table (no RLS -- world-readable via anon key on purpose, for
-- one-time CLI inspection) so the new generated-recipe-photos bucket/policies can mirror
-- recipe-photos exactly. Dropped by the very next migration once inspected.
create table public._storage_inspect (info text);

insert into public._storage_inspect (info)
select format('BUCKET: id=%s name=%s public=%s file_size_limit=%s allowed_mime_types=%s',
  id, name, public, file_size_limit, allowed_mime_types)
from storage.buckets;

insert into public._storage_inspect (info)
select format('POLICY: name=%s cmd=%s qual=%s with_check=%s', policyname, cmd, qual, with_check)
from pg_policies where schemaname = 'storage' and tablename = 'objects';
