CREATE TABLE "category_permission_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"target_type" varchar(10) NOT NULL,
	"target_id" uuid NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "category_permission_overrides_category_id_target_type_target_id_unique" UNIQUE("category_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "page_contents" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"banner_url" varchar(512),
	"version" integer DEFAULT 1 NOT NULL,
	"edited_by" uuid,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"edited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"folder_id" uuid,
	"filename" varchar(255) NOT NULL,
	"url" varchar(512) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" varchar(255) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"token" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_users" DROP CONSTRAINT "local_users_username_unique";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "slowmode_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "nsfw" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "webhook_id" uuid;--> statement-breakpoint
ALTER TABLE "server_config" ADD COLUMN "setup_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_config" ADD COLUMN "show_system_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "server_config" ADD COLUMN "max_shared_storage_bytes" integer DEFAULT 104857600 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "banner_url" varchar(512);--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "default_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "category_permission_overrides" ADD CONSTRAINT "category_permission_overrides_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_contents" ADD CONSTRAINT "page_contents_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_files" ADD CONSTRAINT "shared_files_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_files" ADD CONSTRAINT "shared_files_folder_id_shared_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."shared_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_folders" ADD CONSTRAINT "shared_folders_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_category_perms_category" ON "category_permission_overrides" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_page_revisions_channel" ON "page_revisions" USING btree ("channel_id","version");--> statement-breakpoint
CREATE INDEX "idx_shared_files_server" ON "shared_files" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_shared_files_folder" ON "shared_files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_shared_folders_server" ON "shared_folders" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_shared_folders_parent" ON "shared_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_channel" ON "webhooks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_token" ON "webhooks" USING btree ("id","token");