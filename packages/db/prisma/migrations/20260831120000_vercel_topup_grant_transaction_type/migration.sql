-- A credit package bought on the Vercel rail is its own event, not an overage grant: the customer
-- chose it, it is sized by the package rather than by a cap, and it blocks the next purchase until
-- the invoice is paid. Sharing VERCEL_OVERAGE_GRANT made a purchase indistinguishable from the
-- arrears-billed overage path in the ledger and in the customer's transaction list.
--
-- Existing VERCEL_OVERAGE_GRANT rows are deliberately left alone. Postgres cannot remove an enum
-- value, and the two paths were genuinely conflated before this, so a blanket rewrite would relabel
-- real overage grants as purchases. Rows written before this migration stay as they were.
ALTER TYPE "credit_transaction_type" ADD VALUE IF NOT EXISTS 'VERCEL_TOPUP_GRANT';
