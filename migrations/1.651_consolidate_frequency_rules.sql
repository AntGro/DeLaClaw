-- Migration 1.651: Consolidate frequency_rule formats
-- Merges redundant frequency patterns into the 4 canonical structured formats:
--   every_N_days:N, every_N_weeks:N[:Days], every_N_months:N:DD|pos:Days, yearly:MM-DD
--
-- daily               → every_N_days:1
-- weekly:X            → every_N_weeks:1:X
-- monthly:X           → every_N_months:1:X
-- monthly_weekday:X:Y → every_N_months:1:X:Y

UPDATE habits SET frequency_rule = 'every_N_days:1' WHERE frequency_rule = 'daily';
UPDATE habits SET frequency_rule = 'every_N_weeks:1:' || substring(frequency_rule from 8) WHERE frequency_rule LIKE 'weekly:%';
UPDATE habits SET frequency_rule = 'every_N_months:1:' || substring(frequency_rule from 17) WHERE frequency_rule LIKE 'monthly\_weekday:%';
UPDATE habits SET frequency_rule = 'every_N_months:1:' || substring(frequency_rule from 9) WHERE frequency_rule LIKE 'monthly:%' AND frequency_rule NOT LIKE 'monthly\_%';

INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.651', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
