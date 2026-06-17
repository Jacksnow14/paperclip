CREATE INDEX "gmail_intake_sender_subject_idx" ON "gmail_intake_records" USING btree ("company_id","mailbox","sender","subject");
