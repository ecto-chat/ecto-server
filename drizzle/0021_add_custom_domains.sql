CREATE TABLE "custom_domains" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"domain" varchar(255) NOT NULL,
	"status" varchar(20) NOT NULL,
	CONSTRAINT "custom_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;