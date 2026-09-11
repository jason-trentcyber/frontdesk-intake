"""The ingestion pipeline (#24, ADR-0025): chunk -> embed -> write `chunks`,
update `documents`. Consumes `frontdesk_ingest`; see consumer.py for the
queue-facing half.
"""
