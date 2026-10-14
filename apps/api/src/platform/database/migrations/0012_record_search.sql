-- Global full-text search over territorial records (docs/adr/0011 §5).
-- An expression index keeps module_records' columns (and the tenant export) unchanged.
-- Text is lower-cased and stripped of Spanish accents so "accion" finds "Acción". The
-- simple configuration (no stemming) keeps prefix matching exact while the user types.

CREATE FUNCTION record_search_text(id text, payload jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(
    lower(id || ' ' || COALESCE((SELECT string_agg(value, ' ') FROM jsonb_each_text(payload)), '')),
    'áéíóúüñàèìòùâêîôûäëïö',
    'aeiouunaeiouaeiouaeio')
$$;

CREATE FUNCTION record_search_document(id text, payload jsonb) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('pg_catalog.simple'::regconfig, public.record_search_text(id, payload))
$$;

CREATE INDEX module_records_search ON module_records USING gin (record_search_document(id, payload));

GRANT EXECUTE ON FUNCTION record_search_text(text, jsonb) TO mascli_tenant;
GRANT EXECUTE ON FUNCTION record_search_document(text, jsonb) TO mascli_tenant;
