-- Activates the extensions baked into deploy/postgres/Dockerfile.
-- Runs once, on first container start, against the default POSTGRES_DB.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgmq;
