import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "admin.setApplicationProtocolVersion",
    seed: async ({ harness }) => {
        const app = await harness.db.application.create({
            data: {
                name: "Protocol Toggle App",
                slug: `protocol-toggle-${Date.now()}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        return { appId: app.id };
    },
    cases: (test) => {
        test("a fresh app defaults to the v1 flag", async ({ harness, seedResult: { appId } }) => {
            const app = await harness.db.application.findUniqueOrThrow({ where: { id: appId } });
            expect(app.protocolVersion).toBe("1.0");
        });

        test("the admin toggle flips the app's protocol flag both ways", async ({ harness, seedResult: { appId } }) => {
            await harness.services.admin.setApplicationProtocolVersion(appId, "2.0");
            const promoted = await harness.db.application.findUniqueOrThrow({ where: { id: appId } });
            expect(promoted.protocolVersion).toBe("2.0");

            await harness.services.admin.setApplicationProtocolVersion(appId, "1.0");
            const reverted = await harness.db.application.findUniqueOrThrow({ where: { id: appId } });
            expect(reverted.protocolVersion).toBe("1.0");
        });
    },
});
