-- Scenario v2 (dual-stack): the protocol recorded per scenario_instance at provisioning
-- time (so teardown speaks the right wire), and the hand-set per-application protocol
-- flag - no auto-detection. Default "1.0" (the installed base is v1).
ALTER TABLE "scenario_instance" ADD COLUMN "protocol_version" TEXT;
ALTER TABLE "application" ADD COLUMN "protocol_version" TEXT NOT NULL DEFAULT '1.0';
