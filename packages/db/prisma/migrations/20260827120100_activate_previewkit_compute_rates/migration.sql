-- Activates previewkit compute billing fleet-wide: the first non-zero rate compute has
-- ever had. Kept as its own migration, separate from the USD refactor that precedes it,
-- so it can be held back or reverted without unpicking any code change.
--
-- APPLY BEFORE DEPLOYING, with the migration it follows. Nothing reads these columns until
-- the release that ships with them is out - the usage-meter CronJob that prices compute runs
-- only in production - so activating here charges nobody early; it just means the rate is
-- already in place when that release lands.
--
-- 1.5x the AWS on-demand cost of the reference pair behind the preview app pods
-- (m7i.xlarge at $0.2016 for 4 vCPU/16 GB, r7i.xlarge at $0.2646 for 4 vCPU/32 GB, us-east-1),
-- which isolate to $0.03465/vCPU-hr and $0.0039375/GB-hr via deriveComputeResourceRates:
--
--   vCPU: 0.03465   * 1.5 = $0.051975/hr -> 51975 microdollars
--   GB:   0.0039375 * 1.5 = $0.00590625/hr ->  5906 microdollars
--
-- The 1.5x is margin, deliberately inside the stored price rather than applied through
-- meteredMarkupBps (see the note on both columns in schema.prisma). It also absorbs the
-- cluster overhead per-namespace metering cannot see: Karpenter headroom, system pods and
-- idle nodes are real spend that no preview's cAdvisor series is charged for.
--
-- Every org gets the same USD price; the credits it converts to still varies with each
-- org's own sell rate, which is the intended behaviour.

UPDATE "billing_pricing"
SET "usd_per_vcpu_hour_micros" = 51975,
    "usd_per_gb_hour_micros" = 5906;

ALTER TABLE "billing_pricing" ALTER COLUMN "usd_per_vcpu_hour_micros" SET DEFAULT 51975;
ALTER TABLE "billing_pricing" ALTER COLUMN "usd_per_gb_hour_micros" SET DEFAULT 5906;
