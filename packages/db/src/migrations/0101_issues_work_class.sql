-- AUR-5168: nullable work classification for the 10% self-improvement budget cap.
-- Null means "not yet derived" — derivation always resolves revenue or
-- self_improvement at read time, defaulting to revenue so the cap can never
-- silently starve product work.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "work_class" text;
