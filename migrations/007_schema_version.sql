-- Migration 007: Seed schema_version in settings table
-- 
-- Run this on your Supabase SQL editor after applying all prior migrations (001–006).
-- Also run on local SQLite if you have an existing database.
-- 
-- Version format: MAJOR.MINOR (e.g. 1.00).
-- Future migrations must bump this value.

INSERT INTO settings (key, value) VALUES ('schema_version', '1.000')
ON CONFLICT (key) DO UPDATE SET value = '1.000', updated_at = now();
