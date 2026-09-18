-- Run once in the Supabase SQL editor.
--
-- Access model: only the API talks to the database, using the SERVICE ROLE key
-- (SUPABASE_KEY), which bypasses RLS. So every table gets RLS with no policies
-- (= no anon/authenticated access), except `school_counts`, which the public
-- splash page may read.

BEGIN;

-- 1. Rename referrals -> users ---------------------------------------------
ALTER TABLE IF EXISTS public.referrals RENAME TO users;
ALTER TABLE public.users RENAME CONSTRAINT referrals_pkey TO users_pkey;
CREATE INDEX IF NOT EXISTS users_username_idx ON public.users (username);

-- 2. Lock down every private table -----------------------------------------
ALTER TABLE public.users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_grade_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.users                FROM anon, authenticated;
REVOKE ALL ON public.notifications        FROM anon, authenticated;
REVOKE ALL ON public.push_subscriptions   FROM anon, authenticated;
REVOKE ALL ON public.test_grade_overrides FROM anon, authenticated;

-- 3. Public aggregate table ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.school_counts (
  school text PRIMARY KEY,
  count  integer NOT NULL DEFAULT 0
);
ALTER TABLE public.school_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.school_counts FROM anon, authenticated;
GRANT SELECT ON public.school_counts TO anon, authenticated;

DROP POLICY IF EXISTS "public read school counts" ON public.school_counts;
CREATE POLICY "public read school counts" ON public.school_counts
  FOR SELECT TO anon, authenticated USING (true);

-- Rebuild from the source of truth.
TRUNCATE public.school_counts;
INSERT INTO public.school_counts (school, count)
SELECT school, count(*) FROM public.users GROUP BY school;

-- 4. Trigger keeps counts in sync (atomic, no read-then-write races) -------
CREATE OR REPLACE FUNCTION public.sync_school_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO school_counts (school, count) VALUES (NEW.school, 1)
    ON CONFLICT (school) DO UPDATE SET count = school_counts.count + 1;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE school_counts SET count = count - 1 WHERE school = OLD.school;
    DELETE FROM school_counts WHERE school = OLD.school AND count <= 0;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sync_school_counts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS users_school_counts_ins_del ON public.users;
CREATE TRIGGER users_school_counts_ins_del
AFTER INSERT OR DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.sync_school_counts();

-- Only fire on a real school change (the API re-sets school on every login).
DROP TRIGGER IF EXISTS users_school_counts_upd ON public.users;
CREATE TRIGGER users_school_counts_upd
AFTER UPDATE OF school ON public.users
FOR EACH ROW WHEN (OLD.school IS DISTINCT FROM NEW.school)
EXECUTE FUNCTION public.sync_school_counts();

COMMIT;

-- 5. Realtime for the aggregate only (errors harmlessly if already added) ---
ALTER PUBLICATION supabase_realtime ADD TABLE public.school_counts;
