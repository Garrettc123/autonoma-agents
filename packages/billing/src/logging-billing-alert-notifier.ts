import { Service } from "./service";
import type { BillingAlertNotifier } from "./types";

/** Fallback when no real notifier is wired in - same posture as email's `LoggingEmailSender`. */
export class LoggingBillingAlertNotifier extends Service implements BillingAlertNotifier {
    async notifySpendCapThreshold(input: {
        organizationId: string;
        thresholdPercent: 50 | 80 | 100;
        capAmountCents: number;
        amountChargedCents: number;
        periodEnd: Date;
    }): Promise<void> {
        this.logger.warn("No billing alert notifier configured - spend-cap alert not sent", { extra: input });
    }
}
