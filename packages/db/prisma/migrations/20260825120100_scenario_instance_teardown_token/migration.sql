-- Scenario v2 (add-only): a dedicated column for the v2 opaque teardown token, so it no
-- longer overloads the v1 refs_token column. v2 is unreleased, so no backfill is needed.
ALTER TABLE "scenario_instance" ADD COLUMN "teardown_token" TEXT;
