"""The triage pipeline (#25, REQUIREMENTS F4-F8): classify -> route ->
retrieve -> draft -> confidence. See frontdesk_worker/pipeline.py for the
orchestration and consumer.py for the queue-facing half.
"""
