CREATE TABLE "gmail_outbound_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"recipient" text,
	"subject" text,
	"snippet" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gmail_outbound_records" ADD CONSTRAINT "gmail_outbound_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_outbound_message_uq" ON "gmail_outbound_records" USING btree ("company_id","mailbox","gmail_message_id");
--> statement-breakpoint
CREATE INDEX "gmail_outbound_thread_idx" ON "gmail_outbound_records" USING btree ("company_id","mailbox","gmail_thread_id");
