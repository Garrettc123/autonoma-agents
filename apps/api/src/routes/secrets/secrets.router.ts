import { NotFoundError } from "@autonoma/errors";
import {
    DeleteSecretInputSchema,
    ListSecretAppsInputSchema,
    ListSecretsInputSchema,
    SetSecretBuildTimeInputSchema,
    UpsertSecretsInputSchema,
} from "@autonoma/types";
import { protectedProcedure, writeProcedure, router } from "../../trpc";

export const secretsRouter = router({
    listApps: protectedProcedure
        .input(ListSecretAppsInputSchema)
        .query(({ ctx: { services, organizationId }, input }) =>
            services.secrets.listApps(input.applicationId, organizationId),
        ),

    list: protectedProcedure
        .input(ListSecretsInputSchema)
        .query(({ ctx: { services, organizationId }, input }) =>
            services.secrets.list(input.applicationId, input.appName, organizationId),
        ),

    upsert: writeProcedure
        .input(UpsertSecretsInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.secrets.upsert(input.applicationId, input.appName, input.items, organizationId),
        ),

    setBuildTime: writeProcedure
        .input(SetSecretBuildTimeInputSchema)
        .mutation(async ({ ctx: { services, organizationId }, input }) => {
            const changed = await services.secrets.setBuildTime(
                input.applicationId,
                input.appName,
                input.key,
                input.buildTime,
                organizationId,
            );
            if (!changed) throw new NotFoundError(`Secret '${input.key}' not found`);
        }),

    delete: writeProcedure
        .input(DeleteSecretInputSchema)
        .mutation(async ({ ctx: { services, organizationId }, input }) => {
            const deleted = await services.secrets.delete(
                input.applicationId,
                input.appName,
                input.key,
                organizationId,
            );
            if (!deleted) throw new NotFoundError(`Secret '${input.key}' not found`);
        }),
});
