-- For projects that already applied supabase_run_history_v1_privacy.sql.
-- Replaces only the account-erasure helper; does not rerun table migrations.
-- Verify on isolated staging first. Production requires separate approval.
BEGIN;

CREATE OR REPLACE FUNCTION public.admin_erase_account(target UUID)
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

REVOKE ALL ON FUNCTION public.admin_erase_account(UUID) FROM PUBLIC, anon, authenticated;
COMMIT;
