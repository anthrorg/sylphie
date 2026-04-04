-- Create the runtime application user
CREATE USER sylphie_app WITH PASSWORD 'sylphie_app_dev';

-- Grant connect and usage
GRANT CONNECT ON DATABASE sylphie_system TO sylphie_app;
GRANT USAGE ON SCHEMA public TO sylphie_app;

-- Allow the runtime user to work with tables, sequences, and functions
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sylphie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sylphie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO sylphie_app;
