-- Track daily visits for usage stats (streaks, total days, db age)
CREATE TABLE IF NOT EXISTS daily_visits (
  visit_date DATE PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE daily_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to daily_visits" ON daily_visits FOR ALL USING (true) WITH CHECK (true);

-- Record DB creation date (set once, never overwritten)
INSERT INTO settings (key, value) VALUES ('db_created_at', to_jsonb(now()::text))
ON CONFLICT (key) DO NOTHING;
