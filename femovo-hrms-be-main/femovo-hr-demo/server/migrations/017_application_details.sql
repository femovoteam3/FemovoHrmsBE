-- Migration 017: Details the public application form now asks for.
-- The profile link was already on the form but had nowhere to be saved.
ALTER TABLE applicants
  ADD COLUMN IF NOT EXISTS qualification VARCHAR(150),
  ADD COLUMN IF NOT EXISTS current_location VARCHAR(100),
  ADD COLUMN IF NOT EXISTS portfolio_url TEXT;
