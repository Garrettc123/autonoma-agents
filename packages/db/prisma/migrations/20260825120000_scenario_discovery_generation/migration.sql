-- Scenario v2 (add-only): an explicit discovery-batch key. A v2 scenario is "in the
-- live batch" iff its discovery_id equals the onboarding's recorded last_discovery_id,
-- replacing the earlier exact-timestamp-equality join.
ALTER TABLE "onboarding_state" ADD COLUMN "last_discovery_id" TEXT;
ALTER TABLE "scenario" ADD COLUMN "discovery_id" TEXT;
