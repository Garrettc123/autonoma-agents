/**
 * The `status` values we write to `VercelInvoice`, mirroring the lifecycle Vercel reports: an
 * invoice is raised, then settled, and may later be returned.
 *
 * `Refunded` is deliberately distinct from `Pending` - the money did arrive once, so a refunded
 * invoice keeps its `paidAt` as the record of when. Anything asking "did this invoice leave us
 * paid?" must therefore test the status, not just `paidAt`.
 */
export const VercelInvoiceStatus = {
    Pending: "pending",
    Paid: "paid",
    Refunded: "refunded",
} as const;

export type VercelInvoiceStatusValue = (typeof VercelInvoiceStatus)[keyof typeof VercelInvoiceStatus];
