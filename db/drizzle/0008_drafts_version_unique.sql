ALTER TABLE "drafts" ADD CONSTRAINT "drafts_org_id_request_id_version_unique" UNIQUE("org_id","request_id","version");
