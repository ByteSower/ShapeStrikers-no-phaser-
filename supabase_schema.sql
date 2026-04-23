-- Shape Strikers — Supabase Schema
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)

-- ══════════════════════════════════════════════════════════════════════════════
-- 1. Leaderboard table
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS leaderboard (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id      UUID REFERENCES auth.users(id) NOT NULL,
  player_name    TEXT NOT NULL,
  score          INTEGER NOT NULL DEFAULT 0,
  wave_reached   INTEGER NOT NULL DEFAULT 0,
  campaign_mode  TEXT NOT NULL DEFAULT 'normal',   -- 'normal' | 'void'
  challenge_type TEXT,                              -- 'daily' | 'weekly' | NULL
  challenge_key  TEXT,                              -- '2026-04-16' | '2026-W16' | NULL
  units_used     INTEGER DEFAULT 0,
  won            BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════════════════
-- 2. Indexes (for leaderboard queries)
-- ══════════════════════════════════════════════════════════════════════════════

-- Global leaderboard: top scores where challenge_type IS NULL
CREATE INDEX IF NOT EXISTS idx_leaderboard_global
  ON leaderboard (score DESC)
  WHERE challenge_type IS NULL;

-- Challenge leaderboard: filtered by type + key, ordered by score
CREATE INDEX IF NOT EXISTS idx_leaderboard_challenge
  ON leaderboard (challenge_type, challenge_key, score DESC)
  WHERE challenge_type IS NOT NULL;

-- Personal scores: per-user lookup
CREATE INDEX IF NOT EXISTS idx_leaderboard_player
  ON leaderboard (player_id, score DESC);

-- ══════════════════════════════════════════════════════════════════════════════
-- 3. Row Level Security (RLS)
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE leaderboard ENABLE ROW LEVEL SECURITY;

-- Anyone can read the leaderboard (public access via anon key)
CREATE POLICY "Public read access"
  ON leaderboard FOR SELECT
  USING (true);

-- Authenticated users can insert their own scores only
CREATE POLICY "Users insert own scores"
  ON leaderboard FOR INSERT
  WITH CHECK (auth.uid() = player_id);

-- No UPDATE or DELETE — scores are immutable


-- ══════════════════════════════════════════════════════════════════════════════
-- MULTIPLAYER TABLES (Phase MP-1)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Match Queue ───────────────────────────────────────────────────────────────
-- Tracks players actively searching for a match.
-- Rows are short-lived: status transitions to 'matched' or 'cancelled' quickly.

CREATE TABLE IF NOT EXISTS mp_queue (
  player_id   UUID NOT NULL DEFAULT auth.uid() PRIMARY KEY,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL DEFAULT 'searching'  -- 'searching' | 'matched' | 'cancelled'
);

ALTER TABLE mp_queue ENABLE ROW LEVEL SECURITY;

-- Players can only read/write their own queue row
CREATE POLICY "mp_queue_own"
  ON mp_queue FOR ALL
  USING (player_id = auth.uid());

-- ── Rooms ────────────────────────────────────────────────────────────────────
-- Each row represents one active or completed 1v1 match session.

CREATE TABLE IF NOT EXISTS mp_rooms (
  room_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id  UUID NOT NULL,
  player2_id  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL DEFAULT 'waiting'  -- 'waiting' | 'active' | 'completed'
);

ALTER TABLE mp_rooms ENABLE ROW LEVEL SECURITY;

-- Only the two participants can read/write their room
CREATE POLICY "mp_rooms_participants"
  ON mp_rooms FOR ALL
  USING (player1_id = auth.uid() OR player2_id = auth.uid());

-- ── Room State ───────────────────────────────────────────────────────────────
-- Persists the round-by-round state snapshot so reconnecting players can resync.

CREATE TABLE IF NOT EXISTS mp_room_state (
  room_id        UUID PRIMARY KEY REFERENCES mp_rooms(room_id) ON DELETE CASCADE,
  round_number   INTEGER NOT NULL DEFAULT 0,
  shop_seed      BIGINT,
  battle_seed    BIGINT,
  player1_state  JSONB,
  player2_state  JSONB,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE mp_room_state ENABLE ROW LEVEL SECURITY;

-- Only participants of the linked room can access its state
CREATE POLICY "mp_room_state_participants"
  ON mp_room_state FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM mp_rooms r
      WHERE r.room_id = mp_room_state.room_id
        AND (r.player1_id = auth.uid() OR r.player2_id = auth.uid())
    )
  );

-- Index for fast room_id lookups on state table
CREATE INDEX IF NOT EXISTS idx_mp_room_state_room
  ON mp_room_state (room_id);

