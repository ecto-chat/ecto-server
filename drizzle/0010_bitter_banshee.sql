CREATE TABLE IF NOT EXISTS "shared_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "public"."servers"("id") ON DELETE cascade,
	"parent_id" uuid,
	"name" varchar(255) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shared_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "public"."servers"("id") ON DELETE cascade,
	"folder_id" uuid REFERENCES "public"."shared_folders"("id") ON DELETE cascade,
	"filename" varchar(255) NOT NULL,
	"url" varchar(512) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "setup_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "max_shared_storage_bytes" integer DEFAULT 104857600 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shared_files_server" ON "shared_files" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shared_files_folder" ON "shared_files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shared_folders_server" ON "shared_folders" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shared_folders_parent" ON "shared_folders" USING btree ("parent_id");
