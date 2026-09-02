import { AnalysisEventStore } from "@autonoma/analysis";
import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { triggerAnalysisRun } from "@autonoma/workflow";
import { env } from "../../env";
import { buildGitHubApp } from "../../github/github-app";
import { GitHubInstallationService } from "../../github/github-installation.service";
import { AnalysisTrigger } from "./analysis-trigger";

const githubService = new GitHubInstallationService(db, buildGitHubApp(env));

/**
 * The process-wide {@link AnalysisTrigger} over the shared db client and the real Temporal starter. Used by the
 * HTTP/webhook routers that observe a signal outside the DI container (diffs-http, vercel, github, onboarding).
 * Mirrors the wiring `build-services.ts` does for the DI'd services.
 */
export const analysisTrigger = new AnalysisTrigger(
    db,
    githubService,
    createBillingService(db),
    triggerAnalysisRun,
    new AnalysisEventStore(db),
);
