ALTER TABLE "servers" ADD COLUMN "default_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "webhook_id" uuid;--> statement-breakpoint
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
CREATE INDEX "idx_webhooks_channel" ON "webhooks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_token" ON "webhooks" USING btree ("id","token");
