CREATE TYPE "public"."action_kind" AS ENUM('approve', 'edit', 'reject');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'staff');--> statement-breakpoint
CREATE TYPE "public"."request_source" AS ENUM('form', 'api');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('received', 'triaging', 'drafted', 'needs_human', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."request_urgency" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_email" text NOT NULL,
	"kind" "action_kind" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"name" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED NOT NULL,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_document_id_ord_unique" UNIQUE("document_id","ord")
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"sha256" text NOT NULL,
	"raw" "bytea" NOT NULL,
	"text_content" text,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_org_id_id_unique" UNIQUE("org_id","id"),
	CONSTRAINT "documents_org_id_sha256_unique" UNIQUE("org_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "org_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"daily_token_budget" integer DEFAULT 200000 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source" "request_source" NOT NULL,
	"requester_name" text,
	"requester_email" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"tracking_token" text NOT NULL,
	"status" "request_status" DEFAULT 'received' NOT NULL,
	"category" text,
	"urgency" "request_urgency",
	"summary" text,
	"lane" text,
	"reply_text" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_tracking_token_unique" UNIQUE("tracking_token"),
	CONSTRAINT "requests_org_id_id_unique" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_org_id_request_id_requests_org_id_id_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_org_id_document_id_documents_org_id_id_fk" FOREIGN KEY ("org_id","document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_org_id_request_id_requests_org_id_id_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE POLICY "org_isolation_select" ON "actions" AS PERMISSIVE FOR SELECT TO "frontdesk_app" USING (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation_insert" ON "actions" AS PERMISSIVE FOR INSERT TO "frontdesk_app" WITH CHECK (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO "frontdesk_app" USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chunks" AS PERMISSIVE FOR ALL TO "frontdesk_app" USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation" ON "documents" AS PERMISSIVE FOR ALL TO "frontdesk_app" USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation_select" ON "drafts" AS PERMISSIVE FOR SELECT TO "frontdesk_app" USING (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation_insert" ON "drafts" AS PERMISSIVE FOR INSERT TO "frontdesk_app" WITH CHECK (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_members" AS PERMISSIVE FOR ALL TO "frontdesk_app" USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());--> statement-breakpoint
CREATE POLICY "org_isolation" ON "requests" AS PERMISSIVE FOR ALL TO "frontdesk_app" USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id());