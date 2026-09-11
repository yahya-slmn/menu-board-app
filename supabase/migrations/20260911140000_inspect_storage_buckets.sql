-- Read-only inspection (no schema change) -- dumps existing bucket config and the RLS policies
-- on storage.objects that govern recipe-photos, so the new generated-recipe-photos bucket can
-- mirror them exactly. Output goes to NOTICE (visible in `supabase db push` output).
do $$
declare
  r record;
begin
  for r in select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id loop
    raise notice 'BUCKET: id=% name=% public=% file_size_limit=% allowed_mime_types=%', r.id, r.name, r.public, r.file_size_limit, r.allowed_mime_types;
  end loop;

  for r in select policyname, cmd, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname loop
    raise notice 'POLICY: name=% cmd=% qual=% with_check=%', r.policyname, r.cmd, r.qual, r.with_check;
  end loop;
end $$;
