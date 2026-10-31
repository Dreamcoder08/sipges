timeout 15s psql -h 127.0.0.1 -p 39043 -U mascli_verify -d postgres -At -c 'SELECT name FROM pg_available_extensions WHERE name IN ('"'"'postgis'"'"','"'"'pg_trgm'"'"') ORDER BY name'
