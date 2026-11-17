-- Existing staging installations only; production requires separate approval.
-- Install with no concurrent history clients and deploy the matching client.
BEGIN;

ALTER TABLE public.run_history_erasures
  ADD COLUMN generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0);
ALTER TABLE public.run_history_erasures ALTER COLUMN generation DROP DEFAULT;
DROP TRIGGER run_history_reject_erased ON public.run_history;
DROP FUNCTION public.reject_erased_run_history();
ALTER FUNCTION public.save_run_history(JSONB) RENAME TO save_run_history_unchecked;
REVOKE ALL ON FUNCTION public.save_run_history_unchecked(JSONB) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.get_run_history_generation()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  caller UUID := auth.uid();
  current_generation BIGINT;
BEGIN
  IF caller IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = caller) THEN
    RAISE EXCEPTION 'History requires an authenticated account' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE((SELECT generation FROM public.run_history_erasures WHERE owner_id = caller), 0)
    INTO current_generation;
  RETURN pg_catalog.jsonb_build_object('ownerId', caller, 'generation', current_generation);
END;
$$;

CREATE FUNCTION public.save_run_history(snapshot JSONB, expected_generation BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  caller UUID := auth.uid();
  current_generation BIGINT;
BEGIN
  IF caller IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = caller) THEN
    RAISE EXCEPTION 'History requires an authenticated account' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::TEXT, 7041));
  SELECT COALESCE((SELECT generation FROM public.run_history_erasures WHERE owner_id = caller), 0)
    INTO current_generation;
  IF expected_generation IS NULL OR expected_generation <> current_generation THEN
    RAISE EXCEPTION 'History deletion state changed; review this browser record before restoring it'
      USING ERRCODE = '42501', HINT = 'history_erased';
  END IF;
  RETURN public.save_run_history_unchecked(snapshot);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_my_run_history()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  caller UUID := auth.uid();
  removed INTEGER;
  cutoff TIMESTAMPTZ := pg_catalog.clock_timestamp();
  new_generation BIGINT;
BEGIN
  IF caller IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = caller) THEN
    RAISE EXCEPTION 'History deletion requires an authenticated account' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::TEXT, 7041));
  INSERT INTO public.run_history_erasures (owner_id, erased_at, generation) VALUES (caller, cutoff, 1)
    ON CONFLICT (owner_id) DO UPDATE SET erased_at = EXCLUDED.erased_at,
      generation = public.run_history_erasures.generation + 1
    RETURNING generation INTO new_generation;
  DELETE FROM public.run_history WHERE owner_id = caller;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object('ownerId', caller, 'deleted', removed, 'erasedAt', cutoff, 'generation', new_generation);
END;
$$;

REVOKE ALL ON FUNCTION public.get_run_history_generation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_run_history(JSONB, BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_my_run_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_run_history_generation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_run_history(JSONB, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_run_history() TO authenticated;
COMMIT;
