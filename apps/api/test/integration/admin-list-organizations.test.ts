import { randomBytes } from "node:crypto";
import { measureQueries } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

/**
 * What one page costs: the pinned active organization, the count, the page itself, and the relations
 * Prisma loads alongside them (`_count` per parent query, plus the billing row each row's
 * unlimited-credits badge reads).
 *
 * The point of the budget is that it does not scale with `pageSize` - a relation Prisma loads for
 * the whole batch costs one query whether the page holds two rows or twenty. Raise this only for a
 * genuinely new fixed query, never to accommodate a count that grows with the page.
 */
const ADMIN_ORGANIZATIONS_QUERY_BUDGET = 6;

apiTestSuite({
    name: "admin.listOrganizations",
    seed: async ({ harness }) => {
        const prefix = `admin-list-${randomBytes(4).toString("hex")}`;
        const activeOrganizationName = `${prefix} Zebra Current`;

        await harness.db.organization.update({
            where: { id: harness.organizationId },
            data: {
                name: activeOrganizationName,
                domain: `${prefix}.current.test`,
            },
        });
        harness.user = await harness.db.user.update({
            where: { id: harness.userId },
            data: { role: "admin" },
        });

        await harness.db.organization.createMany({
            data: [
                { name: `${prefix} Alpha`, slug: `${prefix}-alpha`, domain: `${prefix}.alpha.test` },
                { name: `${prefix} Beta`, slug: `${prefix}-beta`, domain: `${prefix}.beta.test` },
                { name: `${prefix} Charlie`, slug: `${prefix}-charlie`, domain: `${prefix}.charlie.test` },
                { name: `${prefix} Delta`, slug: `${prefix}-delta`, domain: `${prefix}.delta.test` },
                { name: `${prefix} No Domain`, slug: `${prefix}-no-domain` },
                {
                    name: `${prefix} Individual Alpha`,
                    slug: `${prefix}-individual-alpha`,
                    domain: `${prefix}-alpha@gmail.com`,
                },
                {
                    name: `${prefix} Individual Beta`,
                    slug: `${prefix}-individual-beta`,
                    domain: `${prefix}-beta@gmail.com`,
                },
            ],
        });

        return { prefix, activeOrganizationName };
    },
    cases: (test) => {
        test("paginates company organizations with the current organization pinned first", async ({
            harness,
            seedResult,
        }) => {
            const firstPage = await harness.request().admin.listOrganizations({
                page: 1,
                pageSize: 2,
                query: seedResult.prefix,
                organizationType: "company",
            });
            const secondPage = await harness.request().admin.listOrganizations({
                page: 2,
                pageSize: 2,
                query: seedResult.prefix,
                organizationType: "company",
            });
            const thirdPage = await harness.request().admin.listOrganizations({
                page: 3,
                pageSize: 2,
                query: seedResult.prefix,
                organizationType: "company",
            });

            expect(firstPage.items.map((org) => org.name)).toEqual([
                seedResult.activeOrganizationName,
                `${seedResult.prefix} Alpha`,
            ]);
            expect(secondPage.items.map((org) => org.name)).toEqual([
                `${seedResult.prefix} Beta`,
                `${seedResult.prefix} Charlie`,
            ]);
            expect(thirdPage.items.map((org) => org.name)).toEqual([
                `${seedResult.prefix} Delta`,
                `${seedResult.prefix} No Domain`,
            ]);
            expect(firstPage).toMatchObject({ page: 1, pageSize: 2, total: 6, totalPages: 3 });
        });

        test("filters individual-user organizations in the database", async ({ harness, seedResult }) => {
            const result = await harness.request().admin.listOrganizations({
                page: 1,
                pageSize: 20,
                query: seedResult.prefix,
                organizationType: "individual",
            });

            expect(result.items.map((org) => org.name)).toEqual([
                `${seedResult.prefix} Individual Alpha`,
                `${seedResult.prefix} Individual Beta`,
            ]);
            expect(result).toMatchObject({ total: 2, totalPages: 1 });
        });

        test("stays within a fixed database query budget", async ({ harness, seedResult }) => {
            const { queryCount } = await measureQueries(() =>
                harness.request().admin.listOrganizations({
                    page: 1,
                    pageSize: 2,
                    query: seedResult.prefix,
                    organizationType: "company",
                }),
            );

            expect(queryCount).toBeLessThanOrEqual(ADMIN_ORGANIZATIONS_QUERY_BUDGET);
        });

        /**
         * The budget above is only meaningful if it is fixed, and a page of two rows is small enough
         * that a per-row relation load would still fit under it. Asserted as an equality between two
         * page sizes rather than against the budget, because the property that matters is that the
         * count does not move with the number of rows - whatever the count happens to be.
         */
        test("costs the same number of queries however many rows the page holds", async ({ harness, seedResult }) => {
            const small = await measureQueries(() =>
                harness.request().admin.listOrganizations({
                    page: 1,
                    pageSize: 2,
                    query: seedResult.prefix,
                    organizationType: "company",
                }),
            );
            const large = await measureQueries(() =>
                harness.request().admin.listOrganizations({
                    page: 1,
                    pageSize: 20,
                    query: seedResult.prefix,
                    organizationType: "company",
                }),
            );

            expect(large.result.items.length).toBeGreaterThan(small.result.items.length);
            expect(large.queryCount).toBe(small.queryCount);
        });
    },
});
