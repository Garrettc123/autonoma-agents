-- Previewkit compute rates move from credits to USD microdollars, and sub-credit
-- consumption gets somewhere to accumulate.
--
-- APPLY BEFORE DEPLOYING. The new code reads all three of these columns -
-- `credit_remainder_micros` from raw SQL in `deductCreditsFloored`, which every credit
-- deduction path goes through - so it cannot run until they exist. The release it replaces
-- reads `credits_per_vcpu_hour`/`credits_per_gb_memory_hour`, which this migration leaves
-- in place, so both work in the window between. Those two are dropped in a later release,
-- once nothing reads them.
--
-- All three default to 0, so a pod still running the old code writes rows that land on
-- harmless values rather than erroring.

-- AlterTable
ALTER TABLE "billing_pricing" ADD COLUMN     "usd_per_vcpu_hour_micros" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "usd_per_gb_hour_micros" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "billing_customer" ADD COLUMN     "credit_remainder_micros" INTEGER NOT NULL DEFAULT 0;
