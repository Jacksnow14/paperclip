CREATE TABLE "gmail_intake_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"issue_id" uuid,
	"sender" text,
	"subject" text,
	"snippet" text,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gmail_intake_records" ADD CONSTRAINT "gmail_intake_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_intake_records" ADD CONSTRAINT "gmail_intake_records_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_intake_message_uq" ON "gmail_intake_records" USING btree ("company_id","mailbox","gmail_message_id");--> statement-breakpoint
CREATE INDEX "gmail_intake_thread_idx" ON "gmail_intake_records" USING btree ("company_id","mailbox","gmail_thread_id");