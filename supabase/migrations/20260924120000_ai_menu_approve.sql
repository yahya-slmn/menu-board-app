-- AI Menu Generator, Phase 4 (Approve): the approval claim and progress record. Purely ADDITIVE:
-- three nullable / defaulted columns on ai_menu_runs; nothing existing changes.
--
-- approve_claim / approve_claimed_at: who holds the run while it is being approved. Approve moves a
-- run draft -> approving with a compare-and-swap (only one of two people clicking at once gets
-- it), and refreshes approve_claimed_at after every step as a heartbeat. A run left in
-- 'approving' whose heartbeat is older than a few minutes was interrupted, and "Resume approval"
-- takes it over (again with a compare-and-swap on the old claim).
-- approve_progress: which sections' menus are already saved ({ "sections": { "DAYCARE": 123 } }),
-- so a resumed approval never saves a section twice. Dishes use ai_menu_draft_dishes.resolved_item_id
-- for the same purpose.

begin;

alter table public.ai_menu_runs
  add column if not exists approve_claim uuid,
  add column if not exists approve_claimed_at timestamptz,
  add column if not exists approve_progress jsonb not null default '{}'::jsonb;

commit;

notify pgrst, 'reload schema';
