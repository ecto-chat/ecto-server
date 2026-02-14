CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid,
	"filename" varchar(255) NOT NULL,
	"url" varchar(512) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" varchar(50) NOT NULL,
	"target_type" varchar(20),
	"target_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bans_server_id_user_id_unique" UNIQUE("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "cached_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" varchar(32) NOT NULL,
	"discriminator" varchar(4) NOT NULL,
	"display_name" varchar(64),
	"avatar_url" varchar(512),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_permission_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"target_type" varchar(10) NOT NULL,
	"target_id" uuid NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "channel_permission_overrides_channel_id_target_type_target_id_unique" UNIQUE("channel_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"category_id" uuid,
	"name" varchar(100) NOT NULL,
	"type" varchar(10) NOT NULL,
	"topic" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_conversations_server_id_user_a_user_b_unique" UNIQUE("server_id","user_a","user_b")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"code" varchar(8) NOT NULL,
	"created_by" uuid NOT NULL,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "local_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" varchar(32) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"display_name" varchar(64),
	"avatar_url" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "member_roles" (
	"member_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "member_roles_member_id_role_id_pk" PRIMARY KEY("member_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"identity_type" varchar(10) NOT NULL,
	"nickname" varchar(64),
	"allow_dms" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_server_id_user_id_unique" UNIQUE("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text,
	"type" smallint DEFAULT 0 NOT NULL,
	"reply_to" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"mention_everyone" boolean DEFAULT false NOT NULL,
	"mention_roles" text[],
	"mention_users" text[],
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_message_id_user_id_emoji_unique" UNIQUE("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "read_states" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_read_message_id" uuid,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_states_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"color" varchar(7),
	"permissions" bigint DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_config" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"setup_completed" boolean DEFAULT false NOT NULL,
	"allow_local_accounts" boolean DEFAULT true NOT NULL,
	"require_invite" boolean DEFAULT false NOT NULL,
	"allow_member_dms" boolean DEFAULT false NOT NULL,
	"max_upload_size_bytes" integer DEFAULT 5242880 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"icon_url" varchar(512),
	"address" varchar(255),
	"admin_user_id" uuid,
	"admin_identity_type" varchar(10) DEFAULT 'global' NOT NULL,
	"central_connected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bans" ADD CONSTRAINT "bans_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_permission_overrides" ADD CONSTRAINT "channel_permission_overrides_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversations" ADD CONSTRAINT "dm_conversations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_config" ADD CONSTRAINT "server_config_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachments_message" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_server_time" ON "audit_log" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_actor" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_bans_server" ON "bans" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_categories_server" ON "categories" USING btree ("server_id","position");--> statement-breakpoint
CREATE INDEX "idx_channel_perms_channel" ON "channel_permission_overrides" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_channels_server" ON "channels" USING btree ("server_id","position");--> statement-breakpoint
CREATE INDEX "idx_channels_category" ON "channels" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_server_dm_conversations_user_a" ON "dm_conversations" USING btree ("server_id","user_a","last_message_at");--> statement-breakpoint
CREATE INDEX "idx_server_dm_conversations_user_b" ON "dm_conversations" USING btree ("server_id","user_b","last_message_at");--> statement-breakpoint
CREATE INDEX "idx_invites_code" ON "invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_invites_server" ON "invites" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_member_roles_role" ON "member_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_members_server" ON "members" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_members_user" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_messages_channel" ON "messages" USING btree ("channel_id","id");--> statement-breakpoint
CREATE INDEX "idx_messages_pinned" ON "messages" USING btree ("channel_id","pinned");--> statement-breakpoint
CREATE INDEX "idx_messages_reply" ON "messages" USING btree ("reply_to");--> statement-breakpoint
CREATE INDEX "idx_reactions_message" ON "reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_roles_server" ON "roles" USING btree ("server_id","position");