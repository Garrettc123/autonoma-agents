import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { isUniqueConstraintError } from "./billing-utils";
import { Service } from "./service";
import type { BillingTopupPackageItem, CreateTopupPackageInput, UpdateTopupPackageInput } from "./types";

const TOPUP_PACKAGE_SELECT = {
    id: true,
    name: true,
    stripePriceId: true,
    priceCents: true,
    creditsGranted: true,
    sortOrder: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
} as const;

/**
 * Admin-curated, global catalog of purchasable top-up sizes (`BillingTopupPackage`) - the menu
 * every org's Checkout/auto-top-up package picker reads from. Mirrors `BillingPromoService`'s CRUD
 * shape; packages are never deleted, only deactivated (`setActive`), since past `CreditTransaction`
 * rows and any org's `autoTopUpPackageId` may still point at one.
 */
export class BillingTopupPackageService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    /** The self-serve picker's source - active packages only, in the admin-defined display order. */
    async listActive(): Promise<BillingTopupPackageItem[]> {
        return this.db.billingTopupPackage.findMany({
            where: { isActive: true },
            orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }],
            select: TOPUP_PACKAGE_SELECT,
        });
    }

    /** The admin view - every package, active or not. */
    async listAll(): Promise<BillingTopupPackageItem[]> {
        return this.db.billingTopupPackage.findMany({
            orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }],
            select: TOPUP_PACKAGE_SELECT,
        });
    }

    async findById(packageId: string): Promise<BillingTopupPackageItem | null> {
        return this.db.billingTopupPackage.findUnique({
            where: { id: packageId },
            select: TOPUP_PACKAGE_SELECT,
        });
    }

    async create(input: CreateTopupPackageInput): Promise<BillingTopupPackageItem> {
        const name = input.name.trim();
        if (name.length === 0) throw new BadRequestError("Package name is required");
        if (input.stripePriceId.trim().length === 0) throw new BadRequestError("Stripe price id is required");
        if (input.priceCents <= 0) throw new BadRequestError("Price must be greater than 0");
        if (input.creditsGranted <= 0) throw new BadRequestError("Credits granted must be greater than 0");

        try {
            const created = await this.db.billingTopupPackage.create({
                data: {
                    name,
                    stripePriceId: input.stripePriceId.trim(),
                    priceCents: input.priceCents,
                    creditsGranted: input.creditsGranted,
                    sortOrder: input.sortOrder ?? 0,
                },
                select: TOPUP_PACKAGE_SELECT,
            });
            this.logger.info("Created top-up package", { packageId: created.id, name: created.name });
            return created;
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                throw new BadRequestError("A package with this Stripe price id already exists");
            }
            throw error;
        }
    }

    async update(packageId: string, input: UpdateTopupPackageInput): Promise<BillingTopupPackageItem> {
        const existing = await this.db.billingTopupPackage.findUnique({
            where: { id: packageId },
            select: { id: true },
        });
        if (existing == null) throw new NotFoundError("Top-up package not found");

        if (input.priceCents != null && input.priceCents <= 0) {
            throw new BadRequestError("Price must be greater than 0");
        }
        if (input.creditsGranted != null && input.creditsGranted <= 0) {
            throw new BadRequestError("Credits granted must be greater than 0");
        }

        const name = input.name?.trim();
        if (input.name != null && name?.length === 0) throw new BadRequestError("Package name cannot be empty");

        const updated = await this.db.billingTopupPackage.update({
            where: { id: packageId },
            data: {
                name,
                priceCents: input.priceCents,
                creditsGranted: input.creditsGranted,
                sortOrder: input.sortOrder,
            },
            select: TOPUP_PACKAGE_SELECT,
        });
        this.logger.info("Updated top-up package", { packageId });
        return updated;
    }

    async setActive(packageId: string, isActive: boolean): Promise<BillingTopupPackageItem> {
        const existing = await this.db.billingTopupPackage.findUnique({
            where: { id: packageId },
            select: { id: true },
        });
        if (existing == null) throw new NotFoundError("Top-up package not found");

        const updated = await this.db.billingTopupPackage.update({
            where: { id: packageId },
            data: { isActive },
            select: TOPUP_PACKAGE_SELECT,
        });
        this.logger.info("Set top-up package active state", { packageId, isActive });
        return updated;
    }
}
