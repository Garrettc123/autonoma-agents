// The one owner registry - "who has to act on this" - shared by the flows list and the open-issues list so the
// same badge (label, tone, icon, and its (i) explanation) can never be worded two different ways across surfaces.
// `client`/`autonoma` are the two acting owners; flows additionally have a `none` case (nobody to chase) that
// callers narrow away before indexing here.

import type { Icon } from "@phosphor-icons/react/lib";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { UserIcon } from "@phosphor-icons/react/User";
import type { FindingBadgeVariant } from "components/investigation/finding-category";

export type AnalysisOwner = "client" | "autonoma";

export interface OwnerMeta {
    label: string;
    variant: FindingBadgeVariant;
    /** Plain-language explanation for the (i) tooltip. */
    description: string;
    icon: Icon;
}

export const OWNER_META: Record<AnalysisOwner, OwnerMeta> = {
    client: {
        label: "Yours to fix",
        variant: "warn",
        description:
            "On your side to fix - a defect in your app, its preview configuration, or its test data. Autonoma reproduced it, but the fix is yours to make.",
        icon: UserIcon,
    },
    autonoma: {
        label: "On us",
        variant: "secondary",
        description: "Autonoma's own harness or infrastructure fell short, not a defect in your app - we handle these.",
        icon: RobotIcon,
    },
};
