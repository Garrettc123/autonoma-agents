-- Drops the credits-denominated previewkit compute rates, retired by
-- usd_per_vcpu_hour_micros/usd_per_gb_hour_micros in migration 20260827120000.
--
-- APPLY AFTER DEPLOYING - the opposite order to the migration that added their
-- replacements, which had to land before its deploy. The release that stopped using these
-- columns still declares them on the Prisma model and selects them by name in
-- BillingPricingService.getOrCreatePricing, which checkCreditsGate goes through: dropping
-- them early stops production from starting any run.
--
-- Merge this only once the release carrying 20260827120000 is out and its rollback window
-- has passed. production-rollback.yml restores images and never the database, so a rollback
-- across this point would put back code that selects columns no longer here.
ALTER TABLE "billing_pricing" DROP COLUMN "credits_per_vcpu_hour";
ALTER TABLE "billing_pricing" DROP COLUMN "credits_per_gb_memory_hour";
