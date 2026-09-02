import type { AnalysisOccurrence } from "../src/analysis/trigger/occurrence";
import type { DeliveryReceipt } from "../src/analysis/trigger/receipt";

/** Records the occurrences delivered so a test can assert exactly one run was fired (and with what). */
export class RecordingAnalysisTrigger {
    public calls: AnalysisOccurrence[] = [];

    constructor(private readonly receipt: DeliveryReceipt = { status: "started", branchId: "branch-1" }) {}

    async deliver(occurrence: AnalysisOccurrence): Promise<DeliveryReceipt> {
        this.calls.push(occurrence);
        return this.receipt;
    }
}

/** A trigger that fails outright, as opposed to one that declines - the two owe the requester different replies. */
export class ThrowingAnalysisTrigger {
    public calls: AnalysisOccurrence[] = [];

    async deliver(occurrence: AnalysisOccurrence): Promise<DeliveryReceipt> {
        this.calls.push(occurrence);
        return Promise.reject(new Error("github is down"));
    }
}
