// Display metadata for an analysis issue's kind, severity, and lifecycle status: a human label + the blacklight
// Badge variant for each, plus the plain-language `description` that feeds the kind badge's (i) hover tooltip. The
// values are the typed `@autonoma/types` enums (the API validates the stored plain strings at the read boundary),
// so these Records are exhaustive - adding a value is a compile error until it is given copy here. An issue carries
// no owner field; owner is derived from kind and rendered from the shared `owner-meta` registry.

import type { AnalysisIssueKind, AnalysisIssueSeverity, AnalysisIssueStatus } from "@autonoma/types";
import { type AnalysisOwner, OWNER_META, type OwnerMeta } from "components/analysis/owner-meta";
import type { FindingBadgeVariant } from "components/investigation/finding-category";

export interface IssueBadgeMeta {
    label: string;
    variant: FindingBadgeVariant;
}

/** A kind badge additionally carries the (i) explanation for what that kind of issue means. */
export interface IssueKindMeta extends IssueBadgeMeta {
    description: string;
}

const KIND_META: Record<AnalysisIssueKind, IssueKindMeta> = {
    bug: {
        label: "Bug",
        variant: "critical",
        description:
            "A defect Autonoma reproduced in your app - it changes what a user can see or do. Bugs block the PR.",
    },
    environment: {
        label: "Environment",
        variant: "high",
        description:
            "The preview environment or its configuration wasn't healthy enough to run the test - not a defect in your app's behavior.",
    },
    scenario: {
        label: "Scenario",
        variant: "warn",
        description:
            "The test needed data or a starting state that wasn't in place (a missing seed, account, or fixture), so the flow couldn't be exercised.",
    },
};

const SEVERITY_META: Record<AnalysisIssueSeverity, IssueBadgeMeta> = {
    critical: { label: "Critical", variant: "critical" },
    high: { label: "High", variant: "high" },
    medium: { label: "Medium", variant: "warn" },
    low: { label: "Low", variant: "secondary" },
};

const STATUS_META: Record<AnalysisIssueStatus, IssueBadgeMeta> = {
    open: { label: "Open", variant: "outline" },
    resolved: { label: "Resolved", variant: "success" },
};

/** Which side owns each kind of issue. A bug is the app's own defect; environment/scenario are test-setup gaps. */
const KIND_OWNER: Record<AnalysisIssueKind, AnalysisOwner> = {
    bug: "client",
    environment: "autonoma",
    scenario: "autonoma",
};

export function analysisIssueKindMeta(kind: AnalysisIssueKind): IssueKindMeta {
    return KIND_META[kind];
}

export function analysisIssueSeverityMeta(severity: AnalysisIssueSeverity): IssueBadgeMeta {
    return SEVERITY_META[severity];
}

export function analysisIssueStatusMeta(status: AnalysisIssueStatus): IssueBadgeMeta {
    return STATUS_META[status];
}

export function analysisIssueOwnerMeta(kind: AnalysisIssueKind): OwnerMeta {
    return OWNER_META[KIND_OWNER[kind]];
}
