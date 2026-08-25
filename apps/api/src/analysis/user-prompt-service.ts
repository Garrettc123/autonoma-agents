import { AnalysisEventStore } from "@autonoma/analysis";
import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { signalWithStartAnalysisRun } from "@autonoma/workflow";
import { env } from "../env";
import { buildGitHubApp } from "../github/github-app";
import { GitHubInstallationService } from "../github/github-installation.service";
import { DeliverUserPromptService } from "./deliver-user-prompt.service";

const githubApp = buildGitHubApp(env);
const githubService = new GitHubInstallationService(db, githubApp);
const billingService = createBillingService(db);

/** The app-wide instance the HTTP route imports; the MCP tool uses the one wired through `buildServices`. */
export const deliverUserPromptService = new DeliverUserPromptService(
    db,
    githubService,
    billingService,
    signalWithStartAnalysisRun,
    new AnalysisEventStore(db),
);
