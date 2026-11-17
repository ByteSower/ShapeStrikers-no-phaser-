-- Run once after supabase_run_history_v1.sql, in the isolated staging project first.
-- Production requires approval. Adds owner self-service history erasure and a
-- maintainer-only full-account erasure helper for verified email requests.
BEGIN;

-- Erasure cutoff per account. Pending uploads of runs started before the cutoff
-- (for example from another device or tab) are rejected rather than re-created.
CREATE TABLE public.run_history_erasures (
  owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  erased_at TIMESTAMPTZ NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0)
);
ALTER TABLE public.run_history_erasures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.run_history_erasures FROM PUBLIC, anon, authenticated;

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

CREATE FUNCTION public.delete_my_run_history()
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

-- Maintainer-only: run from the Supabase SQL Editor after verifying ownership by
-- replying to the account's email address. Not callable through the public API.
CREATE FUNCTION public.admin_erase_account(target UUID)
RETURNS JSONB LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  scores INTEGER;
  telemetry INTEGER;
  rooms INTEGER := 0;
  accounts INTEGER;
BEGIN
  IF target IS NULL THEN
    RAISE EXCEPTION 'Account identifier is required' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.leaderboard WHERE player_id = target;
  GET DIAGNOSTICS scores = ROW_COUNT;
  DELETE FROM public.mp_telemetry_events WHERE player_id = target;
  GET DIAGNOSTICS telemetry = ROW_COUNT;
  IF pg_catalog.to_regclass('public.mp_queue') IS NOT NULL THEN
    DELETE FROM public.mp_queue WHERE player_id = target;
  END IF;
  IF pg_catalog.to_regclass('public.mp_rooms') IS NOT NULL THEN
    DELETE FROM public.mp_rooms WHERE player1_id = target OR player2_id = target;
    GET DIAGNOSTICS rooms = ROW_COUNT;
  END IF;
  -- Cascades to run history, erasure markers, sessions, and identities.
  DELETE FROM auth.users WHERE id = target;
  GET DIAGNOSTICS accounts = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object(
    'accountDeleted', accounts = 1, 'leaderboardRows', scores,
    'telemetryRows', telemetry, 'rooms', rooms
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_run_history_generation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_run_history(JSONB, BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_erase_account(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_my_run_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_run_history_generation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_run_history(JSONB, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_run_history() TO authenticated;
COMMIT;
