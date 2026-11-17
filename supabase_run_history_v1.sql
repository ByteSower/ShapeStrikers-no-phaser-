-- Run once in the isolated staging project first. Production requires approval.
-- This migration does not change leaderboard, multiplayer, or cosmetic data.
-- On a fresh project, apply supabase_schema.sql before this migration.
BEGIN;

CREATE TABLE public.run_history (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'checkpointed', 'won', 'lost', 'abandoned', 'interrupted')),
  campaign_mode TEXT NOT NULL CHECK (campaign_mode IN ('normal', 'void')),
  challenge_type TEXT CHECK (challenge_type IN ('daily', 'weekly')),
  started_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  finalized_at TIMESTAMPTZ,
  terminal_fingerprint TEXT,
  payload JSONB NOT NULL CHECK (
    pg_catalog.jsonb_typeof(payload) = 'object'
    AND pg_catalog.octet_length(pg_catalog.convert_to(payload::TEXT, 'UTF8')) <= 32768
  ),
  CHECK (challenge_type IS NULL OR campaign_mode = 'normal'),
  CHECK ((status IN ('won', 'lost', 'abandoned', 'interrupted')) = (finalized_at IS NOT NULL)),
  CHECK ((finalized_at IS NOT NULL) = (terminal_fingerprint IS NOT NULL))
);

CREATE INDEX run_history_owner_page ON public.run_history (owner_id, created_at DESC, id DESC);
ALTER TABLE public.run_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.run_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.run_history TO authenticated;
CREATE POLICY run_history_owner_read ON public.run_history
  FOR SELECT TO authenticated USING (owner_id = auth.uid());

CREATE FUNCTION public.validate_run_history_v1(snapshot JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  allowed TEXT[] := ARRAY[
    'id', 'version', 'revision', 'status', 'gameVersion', 'campaignMode',
    'challengeType', 'challengeKey', 'modifierId', 'startedAt', 'observedAt',
    'finishedAt', 'completeness', 'waveReached', 'wavesCleared', 'battlesResolved',
    'score', 'recruits', 'firePurchases', 'upgradesBought', 'damage', 'healed',
    'kills', 'bossesDefeated', 'playerLosses', 'iceSurvivors', 'isTest',
    'unitStats', 'participants'
  ];
  key TEXT;
  group_name TEXT;
  item JSONB;
  item_keys TEXT[];
  number_value NUMERIC;
  is_terminal BOOLEAN;
BEGIN
  IF pg_catalog.jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'History snapshot must be an object' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(pg_catalog.convert_to(snapshot::TEXT, 'UTF8')) > 32768 THEN
    RAISE EXCEPTION 'History snapshot exceeds 32 KiB' USING ERRCODE = '22023';
  END IF;
  IF NOT (snapshot ?& allowed) OR EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(snapshot) AS field(key) WHERE NOT (field.key = ANY(allowed))
  ) THEN
    RAISE EXCEPTION 'History snapshot has missing or unsupported fields' USING ERRCODE = '22023';
  END IF;
  FOREACH key IN ARRAY ARRAY['id', 'status', 'gameVersion', 'campaignMode', 'completeness'] LOOP
    IF pg_catalog.jsonb_typeof(snapshot -> key) IS DISTINCT FROM 'string'
      OR pg_catalog.length(snapshot ->> key) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'Invalid history field: %', key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (snapshot ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR snapshot ->> 'status' NOT IN ('started', 'checkpointed', 'won', 'lost', 'abandoned', 'interrupted')
    OR snapshot ->> 'campaignMode' NOT IN ('normal', 'void')
    OR snapshot ->> 'completeness' NOT IN ('complete', 'checkpoint')
    OR snapshot -> 'version' IS DISTINCT FROM '1'::JSONB
    OR pg_catalog.jsonb_typeof(snapshot -> 'isTest') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Invalid history identity, mode, status, or version' USING ERRCODE = '22023';
  END IF;
  FOREACH key IN ARRAY ARRAY['challengeType', 'challengeKey', 'modifierId'] LOOP
    IF pg_catalog.jsonb_typeof(snapshot -> key) NOT IN ('null', 'string') THEN
      RAISE EXCEPTION 'Invalid challenge field: %', key USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.length(snapshot ->> key) > 80 THEN
      RAISE EXCEPTION 'Challenge field too long: %', key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF snapshot ->> 'challengeType' IS NULL THEN
    IF snapshot ->> 'challengeKey' IS NOT NULL OR snapshot ->> 'modifierId' IS NOT NULL THEN
      RAISE EXCEPTION 'Campaign snapshots cannot contain challenge metadata' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF snapshot ->> 'campaignMode' <> 'normal' OR snapshot ->> 'challengeType' NOT IN ('daily', 'weekly')
      OR snapshot ->> 'challengeKey' IS NULL THEN
      RAISE EXCEPTION 'Invalid challenge mode' USING ERRCODE = '22023';
    END IF;
    IF snapshot ->> 'challengeType' = 'daily' AND (
      (snapshot ->> 'challengeKey') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR snapshot ->> 'modifierId' IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Invalid daily challenge metadata' USING ERRCODE = '22023';
    END IF;
    IF snapshot ->> 'challengeType' = 'weekly' AND (
      (snapshot ->> 'challengeKey') !~ '^[0-9]{4}-W[0-9]{2}$'
      OR COALESCE(snapshot ->> 'modifierId', '') = ''
    ) THEN
      RAISE EXCEPTION 'Invalid weekly challenge metadata' USING ERRCODE = '22023';
    END IF;
  END IF;
  FOREACH key IN ARRAY ARRAY[
    'revision', 'waveReached', 'wavesCleared', 'battlesResolved', 'score',
    'recruits', 'firePurchases', 'upgradesBought', 'kills', 'bossesDefeated',
    'playerLosses', 'iceSurvivors', 'damage', 'healed', 'startedAt', 'observedAt'
  ] LOOP
    IF pg_catalog.jsonb_typeof(snapshot -> key) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'History counter must be numeric: %', key USING ERRCODE = '22023';
    END IF;
    number_value := (snapshot ->> key)::NUMERIC;
    IF number_value < 0 OR number_value > 4102444800000
      OR (key NOT IN ('damage', 'healed') AND pg_catalog.trunc(number_value) <> number_value) THEN
      RAISE EXCEPTION 'History counter out of bounds: %', key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (snapshot ->> 'revision')::NUMERIC NOT BETWEEN 1 AND 2147483647
    OR (snapshot ->> 'waveReached')::NUMERIC NOT BETWEEN 1 AND 1000
    OR (snapshot ->> 'wavesCleared')::NUMERIC > (snapshot ->> 'waveReached')::NUMERIC
    OR (snapshot ->> 'firePurchases')::NUMERIC > (snapshot ->> 'recruits')::NUMERIC
    OR (snapshot ->> 'observedAt')::NUMERIC < (snapshot ->> 'startedAt')::NUMERIC THEN
    RAISE EXCEPTION 'Inconsistent history counters' USING ERRCODE = '22023';
  END IF;
  is_terminal := snapshot ->> 'status' IN ('won', 'lost', 'abandoned', 'interrupted');
  IF is_terminal THEN
    IF pg_catalog.jsonb_typeof(snapshot -> 'finishedAt') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Terminal history needs a finish timestamp' USING ERRCODE = '22023';
    END IF;
    number_value := (snapshot ->> 'finishedAt')::NUMERIC;
    IF pg_catalog.trunc(number_value) <> number_value
      OR number_value < (snapshot ->> 'startedAt')::NUMERIC
      OR number_value > (snapshot ->> 'observedAt')::NUMERIC THEN
      RAISE EXCEPTION 'Invalid history finish timestamp' USING ERRCODE = '22023';
    END IF;
  ELSIF snapshot -> 'finishedAt' IS DISTINCT FROM 'null'::JSONB THEN
    RAISE EXCEPTION 'Unfinished history cannot have a finish timestamp' USING ERRCODE = '22023';
  END IF;
  IF snapshot ->> 'status' IN ('won', 'lost') AND snapshot ->> 'completeness' <> 'complete' THEN
    RAISE EXCEPTION 'Win/loss history needs a complete result' USING ERRCODE = '22023';
  END IF;
  FOREACH group_name IN ARRAY ARRAY['unitStats', 'participants'] LOOP
    IF pg_catalog.jsonb_typeof(snapshot -> group_name) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'History squad must be an array' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.jsonb_array_length(snapshot -> group_name) > (CASE WHEN group_name = 'participants' THEN 64 ELSE 128 END) THEN
      RAISE EXCEPTION 'History squad exceeds its bound' USING ERRCODE = '22023';
    END IF;
    item_keys := CASE WHEN group_name = 'participants'
      THEN ARRAY['unitId', 'definitionId', 'name', 'tier', 'element', 'hp', 'maxHp', 'survived']
      ELSE ARRAY['definitionId', 'name', 'tier', 'element', 'recruits', 'damage', 'healed', 'kills'] END;
    FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(snapshot -> group_name) LOOP
      IF pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid history squad entry' USING ERRCODE = '22023';
      END IF;
      IF NOT (item ?& item_keys) OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_object_keys(item) AS field(key) WHERE NOT (field.key = ANY(item_keys))
      ) THEN
        RAISE EXCEPTION 'Unsupported history squad fields' USING ERRCODE = '22023';
      END IF;
      FOREACH key IN ARRAY item_keys LOOP
        IF key IN ('unitId', 'definitionId', 'name', 'element') THEN
          IF pg_catalog.jsonb_typeof(item -> key) IS DISTINCT FROM 'string'
            OR pg_catalog.length(item ->> key) NOT BETWEEN 1 AND 80 THEN
            RAISE EXCEPTION 'Invalid squad text: %', key USING ERRCODE = '22023';
          END IF;
        ELSIF key = 'survived' THEN
          IF pg_catalog.jsonb_typeof(item -> key) IS DISTINCT FROM 'boolean' THEN
            RAISE EXCEPTION 'Invalid survivor flag' USING ERRCODE = '22023';
          END IF;
        ELSE
          IF pg_catalog.jsonb_typeof(item -> key) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'Invalid squad counter: %', key USING ERRCODE = '22023';
          END IF;
          number_value := (item ->> key)::NUMERIC;
          IF number_value < 0 OR number_value > 4102444800000
            OR (key IN ('tier', 'recruits', 'kills') AND pg_catalog.trunc(number_value) <> number_value) THEN
            RAISE EXCEPTION 'Squad counter out of bounds: %', key USING ERRCODE = '22023';
          END IF;
        END IF;
      END LOOP;
      IF (item ->> 'tier')::NUMERIC NOT BETWEEN 1 AND 10 THEN
        RAISE EXCEPTION 'Invalid squad tier' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

CREATE FUNCTION public.save_run_history_unchecked(snapshot JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  caller UUID := auth.uid();
  run_id UUID;
  previous public.run_history%ROWTYPE;
  is_terminal BOOLEAN;
BEGIN
  IF caller IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = caller) THEN
    RAISE EXCEPTION 'History requires an authenticated account' USING ERRCODE = '42501';
  END IF;
  PERFORM public.validate_run_history_v1(snapshot);
  run_id := (snapshot ->> 'id')::UUID;
  is_terminal := snapshot ->> 'status' IN ('won', 'lost', 'abandoned', 'interrupted');
  INSERT INTO public.run_history (
    id, owner_id, schema_version, revision, status, campaign_mode, challenge_type,
    started_at, finalized_at, terminal_fingerprint, payload
  ) VALUES (
    run_id, caller, 1, (snapshot ->> 'revision')::INTEGER, snapshot ->> 'status',
    snapshot ->> 'campaignMode', snapshot ->> 'challengeType',
    pg_catalog.to_timestamp((snapshot ->> 'startedAt')::DOUBLE PRECISION / 1000),
    CASE WHEN is_terminal THEN pg_catalog.now() END,
    CASE WHEN is_terminal THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(snapshot::TEXT, 'UTF8')), 'hex') END,
    snapshot
  ) ON CONFLICT (id) DO NOTHING;
  SELECT * INTO previous FROM public.run_history WHERE id = run_id FOR UPDATE;
  IF previous.owner_id <> caller THEN
    RAISE EXCEPTION 'History belongs to another account' USING ERRCODE = '42501';
  END IF;
  IF previous.finalized_at IS NOT NULL THEN
    -- Compare the complete payload, not just a fingerprint.
    IF previous.payload IS DISTINCT FROM snapshot THEN
      RAISE EXCEPTION 'Conflicting terminal history' USING ERRCODE = '23505';
    END IF;
  ELSIF (snapshot ->> 'revision')::INTEGER = previous.revision AND previous.payload IS DISTINCT FROM snapshot THEN
    RAISE EXCEPTION 'Conflicting history revision' USING ERRCODE = '23505';
  ELSIF (snapshot ->> 'revision')::INTEGER > previous.revision THEN
    IF previous.started_at <> pg_catalog.to_timestamp((snapshot ->> 'startedAt')::DOUBLE PRECISION / 1000)
      OR previous.campaign_mode <> snapshot ->> 'campaignMode'
      OR previous.challenge_type IS DISTINCT FROM snapshot ->> 'challengeType'
      OR previous.payload -> 'challengeKey' IS DISTINCT FROM snapshot -> 'challengeKey'
      OR previous.payload -> 'modifierId' IS DISTINCT FROM snapshot -> 'modifierId'
      OR previous.payload -> 'isTest' IS DISTINCT FROM snapshot -> 'isTest' THEN
      RAISE EXCEPTION 'History identity cannot change' USING ERRCODE = '22023';
    END IF;
    UPDATE public.run_history SET
      revision = (snapshot ->> 'revision')::INTEGER, status = snapshot ->> 'status',
      updated_at = pg_catalog.now(),
      finalized_at = CASE WHEN is_terminal THEN pg_catalog.now() END,
      terminal_fingerprint = CASE WHEN is_terminal THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(snapshot::TEXT, 'UTF8')), 'hex') END,
      payload = snapshot
    WHERE id = run_id;
    SELECT * INTO previous FROM public.run_history WHERE id = run_id;
  ELSIF is_terminal THEN
    RAISE EXCEPTION 'Terminal history is older than its checkpoint' USING ERRCODE = '22023';
  END IF;
  RETURN pg_catalog.jsonb_build_object('id', previous.id, 'ownerId', caller, 'revision', previous.revision, 'status', previous.status);
END;
$$;

CREATE FUNCTION public.list_run_history(
  page_size INTEGER DEFAULT 20, before_created_at TIMESTAMPTZ DEFAULT NULL,
  before_id UUID DEFAULT NULL, mode_filter TEXT DEFAULT 'all', include_tests BOOLEAN DEFAULT FALSE
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'History requires authentication' USING ERRCODE = '42501';
  END IF;
  IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 20 OR mode_filter IS NULL
    OR mode_filter NOT IN ('all', 'normal', 'void', 'daily', 'weekly')
    OR (before_created_at IS NULL) <> (before_id IS NULL) OR include_tests IS NULL THEN
    RAISE EXCEPTION 'Invalid history pagination or filter' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT * FROM public.run_history
    WHERE owner_id = auth.uid()
      AND (before_id IS NULL OR (created_at, id) < (before_created_at, before_id))
      AND (include_tests OR payload -> 'isTest' = 'false'::JSONB)
      AND (mode_filter = 'all'
        OR (mode_filter IN ('normal', 'void') AND campaign_mode = mode_filter AND challenge_type IS NULL)
        OR challenge_type = mode_filter)
    ORDER BY created_at DESC, id DESC LIMIT page_size + 1
  ), page AS (
    SELECT * FROM candidates ORDER BY created_at DESC, id DESC LIMIT page_size
  )
  SELECT pg_catalog.jsonb_build_object(
    'records', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', id, 'createdAt', created_at,
        'summary', payload - 'unitStats' - 'participants'
      ) ORDER BY created_at DESC, id DESC) FROM page
    ), '[]'::JSONB),
    'hasMore', (SELECT pg_catalog.count(*) > page_size FROM candidates),
    'cursor', (SELECT pg_catalog.jsonb_build_object('createdAt', created_at, 'id', id)
      FROM page ORDER BY created_at ASC, id ASC LIMIT 1)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE FUNCTION public.run_history_totals()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE result JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'History requires authentication' USING ERRCODE = '42501';
  END IF;
  WITH owned AS (
    SELECT * FROM public.run_history WHERE owner_id = auth.uid()
  ), eligible AS (
    SELECT * FROM owned WHERE status IN ('won', 'lost')
      AND payload -> 'isTest' = 'false'::JSONB AND payload ->> 'completeness' = 'complete'
  ), categories AS (
    SELECT campaign_mode, challenge_type, status, payload -> 'isTest' AS test_record,
      payload ->> 'completeness' AS completeness, pg_catalog.count(*) AS attempts
    FROM owned GROUP BY campaign_mode, challenge_type, status, payload -> 'isTest', payload ->> 'completeness'
  )
  SELECT pg_catalog.jsonb_build_object(
    'completed', (SELECT pg_catalog.count(*) FROM eligible),
    'wins', (SELECT pg_catalog.count(*) FROM eligible WHERE status = 'won'),
    'losses', (SELECT pg_catalog.count(*) FROM eligible WHERE status = 'lost'),
    'damage', COALESCE((SELECT pg_catalog.sum((payload ->> 'damage')::NUMERIC) FROM eligible), 0),
    'healed', COALESCE((SELECT pg_catalog.sum((payload ->> 'healed')::NUMERIC) FROM eligible), 0),
    'kills', COALESCE((SELECT pg_catalog.sum((payload ->> 'kills')::NUMERIC) FROM eligible), 0),
    'recruits', COALESCE((SELECT pg_catalog.sum((payload ->> 'recruits')::NUMERIC) FROM eligible), 0),
    'bossesDefeated', COALESCE((SELECT pg_catalog.sum((payload ->> 'bossesDefeated')::NUMERIC) FROM eligible), 0),
    'trackedSince', (SELECT pg_catalog.min(started_at) FROM owned WHERE payload -> 'isTest' = 'false'::JSONB),
    'categories', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(categories)
      ORDER BY campaign_mode, challenge_type, status, test_record, completeness) FROM categories), '[]'::JSONB)
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_run_history_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_run_history_unchecked(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_run_history(INTEGER, TIMESTAMPTZ, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.run_history_totals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_run_history(INTEGER, TIMESTAMPTZ, UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.run_history_totals() TO authenticated;
COMMIT;
