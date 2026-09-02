import {
    OpenChatSessionInputSchema,
    PollChatTurnInputSchema,
    ResolveChatForwardInputSchema,
    SendChatTurnInputSchema,
} from "@autonoma/types";
import { protectedProcedure, router, writeProcedure } from "../../trpc";

export const chatRouter = router({
    // Query so the panel hydrates with Suspense; the stub creates-on-read.
    openSession: protectedProcedure
        .input(OpenChatSessionInputSchema)
        .query(({ ctx: { services, organizationId }, input }) =>
            services.chat.openSession(organizationId, input.applicationId, input.prNumber),
        ),

    sendTurn: writeProcedure
        .input(SendChatTurnInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.chat.sendTurn(organizationId, input.sessionId, input.message),
        ),

    // The UI polls this until the reply (and any receipt) lands.
    pollTurn: protectedProcedure
        .input(PollChatTurnInputSchema)
        .query(({ ctx: { services, organizationId }, input }) =>
            services.chat.pollTurn(organizationId, input.sessionId, input.turnId),
        ),

    resolveForward: writeProcedure
        .input(ResolveChatForwardInputSchema)
        .mutation(({ ctx: { services, organizationId }, input }) =>
            services.chat.resolveForward(organizationId, input.sessionId, input.turnId, input.offerId, input.decision),
        ),
});
