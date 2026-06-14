-- Enable the HTTP extension (needed for server-side HTTP calls)
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- Proxy function: calls NVIDIA chat completions API from Supabase
CREATE OR REPLACE FUNCTION nvidia_chat(p_api_key text, p_model text, p_prompt text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  resp record;
BEGIN
  SELECT * INTO resp FROM extensions.http((
    'POST',
    'https://integrate.api.nvidia.com/v1/chat/completions',
    ARRAY[extensions.http_header('Authorization', 'Bearer ' || p_api_key)],
    'application/json',
    json_build_object(
      'model', p_model,
      'messages', json_build_array(json_build_object('role', 'user', 'content', p_prompt)),
      'max_tokens', 256
    )::text
  )::extensions.http_request);

  BEGIN
    RETURN json_build_object('status', resp.status, 'body', resp.content::json);
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('status', resp.status, 'body', json_build_object('error', resp.content));
  END;
END;
$$;

-- List available NVIDIA models (no auth required)
CREATE OR REPLACE FUNCTION nvidia_list_models()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  resp record;
BEGIN
  SELECT * INTO resp FROM extensions.http((
    'GET',
    'https://integrate.api.nvidia.com/v1/models',
    ARRAY[]::extensions.http_header[],
    NULL,
    NULL
  )::extensions.http_request);

  BEGIN
    RETURN resp.content::json;
  EXCEPTION WHEN OTHERS THEN
    RETURN json_build_object('error', resp.content);
  END;
END;
$$;
