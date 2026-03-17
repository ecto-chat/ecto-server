CREATE TABLE "server_refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_refresh_tokens" ADD CONSTRAINT "server_refresh_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_srt_member" ON "server_refresh_tokens" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "idx_srt_token_hash" ON "server_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_srt_expires" ON "server_refresh_tokens" USING btree ("expires_at");