-- Billing-exempt organizations: gates always pass and the balance never moves, while consumption
-- is still recorded in credit_transaction for auditing.
ALTER TABLE "billing_customer" ADD COLUMN "unlimited_credits" BOOLEAN NOT NULL DEFAULT false;
