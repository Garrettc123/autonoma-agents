-- At most one unpaid credit purchase per organization, enforced by the database rather than only by
-- the read-then-write in VercelCreditPurchaseService. Credits are granted before the invoice is
-- raised, so a second concurrent grant hands out a package nobody is billed for.
--
-- Partial indexes cannot be expressed in schema.prisma, so this index lives only here. A future
-- `prisma migrate dev` will therefore propose dropping it as drift - delete that statement from the
-- generated migration; see the note on the VercelCreditPurchase model.
CREATE UNIQUE INDEX "vercel_credit_purchase_one_unpaid_per_org"
    ON "vercel_credit_purchase" ("organization_id")
    WHERE "invoice_id" IS NULL;
