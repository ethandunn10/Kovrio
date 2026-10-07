-- supabase/attempts-subject.sql
-- Adds a `subject` column to the anonymous Attempts table, so usage can be
-- broken out per subject (ap-gov, ap-bio, ...). Run once in Supabase:
-- Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Run this BEFORE the code that sends `subject` goes live.

alter table public."Attempts" add column if not exists subject text;

-- Fill in the subject for attempts logged before this column existed.
-- Every subject except AP Gov puts its prefix on its ids (bio-, ush-, ...).
update public."Attempts"
set subject = case
  when question_id like 'bio-%'   then 'ap-bio'
  when question_id like 'ush-%'   then 'ap-ush'
  when question_id like 'psych-%' then 'ap-psych'
  when question_id like 'chem-%'  then 'ap-chem'
  when question_id like 'world-%' then 'ap-world'
  when question_id like 'euro-%'  then 'ap-euro'
  when question_id like 'hug-%'   then 'ap-hug'
  when question_id like 'apes-%'  then 'ap-apes'
  else 'ap-gov'
end
where subject is null;
