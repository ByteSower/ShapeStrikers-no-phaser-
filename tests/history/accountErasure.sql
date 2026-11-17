-- Maintainer-only isolated STAGING check after the privacy migration/repair.
-- Temporarily renames optional tables inside this rolled-back transaction.
-- Run without concurrent staging activity. Never run on production.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL plpgsql.check_asserts = on;

CREATE FUNCTION pg_temp.erasure_fixture()
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  account UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, aud, role, is_anonymous, raw_user_meta_data)
    VALUES (account, 'authenticated', 'authenticated', true, '{"privacy_repair_fixture":true}');
  INSERT INTO public.leaderboard (player_id, player_name) VALUES (account, 'Privacy repair fixture');
  INSERT INTO public.mp_telemetry_events (id, player_id, event_type, client_at)
    VALUES (gen_random_uuid(), account, 'privacy_repair_fixture', now());
  INSERT INTO public.run_history
    (id, owner_id, schema_version, revision, status, campaign_mode, started_at, payload)
    VALUES (gen_random_uuid(), account, 1, 1, 'started', 'normal', now(), '{}');
  INSERT INTO public.run_history_erasures (owner_id, erased_at, generation) VALUES (account, now(), 1);
  RETURN account;
END;
$$;

CREATE FUNCTION pg_temp.check_erased(account UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM auth.users WHERE id = account), 'Auth user survived';
  ASSERT NOT EXISTS (SELECT 1 FROM public.leaderboard WHERE player_id = account), 'Score survived';
  ASSERT NOT EXISTS (SELECT 1 FROM public.mp_telemetry_events WHERE player_id = account), 'Telemetry survived';
  ASSERT NOT EXISTS (SELECT 1 FROM public.run_history WHERE owner_id = account), 'History survived';
  ASSERT NOT EXISTS (SELECT 1 FROM public.run_history_erasures WHERE owner_id = account), 'Erasure marker survived';
END;
$$;

CREATE FUNCTION pg_temp.reject_fixture_erasure()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Intentional fixture deletion failure' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER privacy_repair_failure
  BEFORE DELETE ON auth.users FOR EACH ROW
  WHEN (OLD.raw_user_meta_data ->> 'privacy_repair_blocked' = 'true')
  EXECUTE FUNCTION pg_temp.reject_fixture_erasure();

DO $test$
DECLARE
  subject UUID;
  control UUID := pg_temp.erasure_fixture();
  room UUID;
  reverse_room UUID;
  result JSONB;
  rejected BOOLEAN := false;
BEGIN
  ASSERT to_regclass('public.mp_queue') IS NOT NULL, 'Requires full staging schema';
  ASSERT to_regclass('public.mp_rooms') IS NOT NULL, 'Requires full staging schema';
  ASSERT to_regclass('public.privacy_repair_queue') IS NULL, 'Fixture table name collision';
  ASSERT to_regclass('public.privacy_repair_rooms') IS NULL, 'Fixture table name collision';
  ASSERT NOT has_function_privilege('anon', 'public.admin_erase_account(uuid)', 'EXECUTE'), 'Anonymous access allowed';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_erase_account(uuid)', 'EXECUTE'), 'Player access allowed';

  subject := pg_temp.erasure_fixture();
  INSERT INTO public.mp_queue (player_id) VALUES (subject), (control);
  INSERT INTO public.mp_rooms (player1_id, player2_id, status)
    VALUES (subject, control, 'completed') RETURNING room_id INTO room;
  INSERT INTO public.mp_rooms (player1_id, player2_id, status)
    VALUES (control, subject, 'completed') RETURNING room_id INTO reverse_room;
  INSERT INTO public.mp_room_state (room_id) VALUES (room), (reverse_room);
  result := public.admin_erase_account(subject);
  ASSERT result @> '{"accountDeleted":true,"leaderboardRows":1,"telemetryRows":1,"rooms":2}', 'Full-schema deletion counts';
  PERFORM pg_temp.check_erased(subject);
  ASSERT NOT EXISTS (SELECT 1 FROM public.mp_queue WHERE player_id = subject), 'Queue survived';
  ASSERT NOT EXISTS (SELECT 1 FROM public.mp_rooms WHERE room_id IN (room, reverse_room)), 'Rooms survived';
  ASSERT NOT EXISTS (SELECT 1 FROM public.mp_room_state WHERE room_id IN (room, reverse_room)), 'Room state survived';

  ALTER TABLE public.mp_queue RENAME TO privacy_repair_queue;
  subject := pg_temp.erasure_fixture();
  INSERT INTO public.mp_rooms (player1_id, player2_id, status)
    VALUES (subject, control, 'completed');
  result := public.admin_erase_account(subject);
  ASSERT result @> '{"accountDeleted":true,"rooms":1}', 'Missing queue deletion failed';
  PERFORM pg_temp.check_erased(subject);

  ALTER TABLE public.mp_rooms RENAME TO privacy_repair_rooms;
  subject := pg_temp.erasure_fixture();
  result := public.admin_erase_account(subject);
  ASSERT result @> '{"accountDeleted":true,"leaderboardRows":1,"telemetryRows":1,"rooms":0}', 'Minimal schema deletion failed';
  PERFORM pg_temp.check_erased(subject);

  ALTER TABLE public.privacy_repair_queue RENAME TO mp_queue;
  subject := pg_temp.erasure_fixture();
  INSERT INTO public.mp_queue (player_id) VALUES (subject);
  result := public.admin_erase_account(subject);
  ASSERT result @> '{"accountDeleted":true,"rooms":0}', 'Missing rooms deletion failed';
  PERFORM pg_temp.check_erased(subject);
  ASSERT NOT EXISTS (SELECT 1 FROM public.mp_queue WHERE player_id = subject), 'Queue cleanup skipped';
  ALTER TABLE public.privacy_repair_rooms RENAME TO mp_rooms;

  subject := pg_temp.erasure_fixture();
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data || '{"privacy_repair_blocked":true}'
    WHERE id = subject;
  BEGIN
    PERFORM public.admin_erase_account(subject);
  EXCEPTION WHEN check_violation THEN
    rejected := true;
  END;
  ASSERT rejected, 'Real deletion failure was swallowed';
  ASSERT EXISTS (SELECT 1 FROM auth.users WHERE id = subject), 'Failed deletion removed account';
  ASSERT EXISTS (SELECT 1 FROM public.leaderboard WHERE player_id = subject), 'Failed deletion removed score';
  ASSERT EXISTS (SELECT 1 FROM public.mp_telemetry_events WHERE player_id = subject), 'Failed deletion removed telemetry';
  ASSERT EXISTS (SELECT 1 FROM public.run_history WHERE owner_id = subject), 'Failed deletion removed history';

  ASSERT EXISTS (SELECT 1 FROM auth.users WHERE id = control), 'Control user affected';
  ASSERT EXISTS (SELECT 1 FROM public.leaderboard WHERE player_id = control), 'Control score affected';
  ASSERT EXISTS (SELECT 1 FROM public.mp_telemetry_events WHERE player_id = control), 'Control telemetry affected';
  ASSERT EXISTS (SELECT 1 FROM public.run_history WHERE owner_id = control), 'Control history affected';
  ASSERT EXISTS (SELECT 1 FROM public.run_history_erasures WHERE owner_id = control), 'Control erasure marker affected';
  ASSERT EXISTS (SELECT 1 FROM public.mp_queue WHERE player_id = control), 'Control queue affected';
END;
$test$;

SELECT 'PASS: full and optional-table schemas, isolation, privileges, and atomic failure; fixtures rolled back' AS result;
ROLLBACK;
