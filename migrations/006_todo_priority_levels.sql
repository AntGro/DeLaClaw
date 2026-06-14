-- Migration 006: Expand TODO priority levels
-- Adds 'urgent' and 'medium' to the allowed priority values
-- 
-- Run this on your Supabase SQL editor:
--   1. Go to https://supabase.com/dashboard → SQL Editor
--   2. Paste this file and click "Run"

-- Drop the old check constraint (only allowed high/normal/low)
ALTER TABLE public.todos DROP CONSTRAINT IF EXISTS todos_priority_check;

-- Add new constraint with all 5 levels
ALTER TABLE public.todos ADD CONSTRAINT todos_priority_check 
  CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'normal'));
