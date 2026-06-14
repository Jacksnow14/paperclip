CREATE TABLE "telegram_intake_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"telegram_message_id" text NOT NULL,
	"issue_id" uuid,
	"reel_url" text,
	"snippet" text,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_intake_records" ADD CONSTRAINT "telegram_intake_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "telegram_intake_records" ADD CONSTRAINT "telegram_intake_records_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_intake_message_uq" ON "telegram_intake_records" USING btree ("company_id","telegram_message_id");
--> statement-breakpoint
CREATE INDEX "telegram_intake_chat_idx" ON "telegram_intake_records" USING btree ("company_id","telegram_chat_id");
