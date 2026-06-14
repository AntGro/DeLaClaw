-- Migration 003: Add avatar_url column to birthdays
-- Stores a small base64-encoded JPEG data URL for the birthday avatar photo.
ALTER TABLE public.birthdays ADD COLUMN IF NOT EXISTS avatar_url TEXT;
