import { Service } from "./service";
import type { AutoTopUpFailedAlert, BillingAlertNotifier, SpendCapThresholdAlert } from "./types";

/** Fallback when no real notifier is wired in - same posture as email's `LoggingEmailSender`. */
export class LoggingBillingAlertNotifier extends Service implements BillingAlertNotifier {
    async notifySpendCapThreshold(input: SpendCapThresholdAlert): Promise<void> {
        this.logger.warn("No billing alert notifier configured - spend-cap alert not sent", { extra: input });
    }

    async notifyAutoTopUpFailed(input: AutoTopUpFailedAlert): Promise<void> {
        // Not the only signal, unlike the spend-cap alert above: `AutoTopUpService` has already
        // recorded this on the customer row, so the billing page shows it even from here.
        this.logger.warn("No billing alert notifier configured - auto top-up failure email not sent", {
            extra: input,
        });
    }
}
