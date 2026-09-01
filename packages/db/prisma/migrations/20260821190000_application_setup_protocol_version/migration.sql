-- The planner protocol selects which artifacts Finish setup requires. Existing
-- setup rows are v1; new v2 CLI runs opt in explicitly before generating work.
ALTER TABLE "application_setup"
ADD COLUMN "protocol_version" TEXT NOT NULL DEFAULT '1.0';
