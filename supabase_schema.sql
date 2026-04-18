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

