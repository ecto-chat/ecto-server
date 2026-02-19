CREATE TABLE "shared_item_permission_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_type" varchar(10) NOT NULL,
	"item_id" uuid NOT NULL,
	"target_type" varchar(10) NOT NULL,
	"target_id" uuid NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "shared_item_permission_overrides_item_type_item_id_target_type_target_id_unique" UNIQUE("item_type","item_id","target_type","target_id")
);
--> statement-breakpoint
ALTER TABLE "server_config" ALTER COLUMN "max_shared_storage_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "server_config" ALTER COLUMN "max_shared_storage_bytes" SET DEFAULT 104857600;--> statement-breakpoint
CREATE INDEX "idx_shared_item_perms_item" ON "shared_item_permission_overrides" USING btree ("item_type","item_id");