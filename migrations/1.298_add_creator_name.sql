-- Migration 1.298: Add creator_name to verify_join_token RPC
-- NOTE: return type changes from 5 to 6 columns, so we must DROP first
-- (Postgres does not allow CREATE OR REPLACE when return type differs).

DROP FUNCTION IF EXISTS "public"."verify_join_token"("text");

CREATE OR REPLACE FUNCTION "public"."verify_join_token"("p_token" "text")
RETURNS TABLE("group_id" "text", "group_name" "text", "member_id" "text",
              "display_name" "text", "backend_type" "text", "creator_name" "text")
LANGUAGE "sql" SECURITY DEFINER AS $$
  SELECT sg.id, sg.name, sm.member_id, sm.display_name, sg.backend_type,
         (SELECT cm.display_name FROM sharing_members cm
          WHERE cm.group_id = sg.id AND cm.role = 'creator' LIMIT 1)
  FROM sharing_members sm
  JOIN sharing_groups sg ON sg.id = sm.group_id
  WHERE sm.token = p_token AND sm.joined_at IS NULL;
$$;

INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', '1.298', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
