CREATE TABLE "activity_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"actor_id" uuid NOT NULL,
	"message_id" uuid,
	"channel_id" uuid,
	"conversation_id" uuid,
	"content_preview" text,
	"emoji" varchar(64),
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_activity_user_created" ON "activity_items" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_activity_user_read" ON "activity_items" USING btree ("user_id","read");