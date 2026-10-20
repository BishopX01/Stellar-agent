import { scValToNative, xdr } from "@stellar/stellar-sdk";

const JOB_EVENT_TYPES = new Set([
  "JobSubmitted",
  "JobCompleted",
  "JobCancelled",
  "JobDisputed",
]);

function eventJobId(event: Record<string, unknown>): bigint | null {
  const payload = (event.payload ?? event.data) as Record<string, unknown> | undefined;
  const value = payload?.value;
  try {
    let nativeValue: unknown = value;
    if (value instanceof xdr.ScVal) {
      nativeValue = scValToNative(value);
    } else if (typeof value === "string") {
      nativeValue = scValToNative(xdr.ScVal.fromXDR(value, "base64"));
    } else if (
      typeof value === "object" &&
      value !== null &&
      "xdr" in value &&
      typeof value.xdr === "string"
    ) {
      nativeValue = scValToNative(xdr.ScVal.fromXDR(value.xdr, "base64"));
    }
    const rawJobId = Array.isArray(nativeValue)
      ? nativeValue[0]
      : typeof nativeValue === "object" && nativeValue !== null
        ? (nativeValue as Record<string, unknown>).job_id ??
          (nativeValue as Record<string, unknown>).jobId ??
          (nativeValue as Record<string, unknown>).id
        : nativeValue;
    if (typeof rawJobId === "bigint") return rawJobId;
    if (typeof rawJobId === "string" || typeof rawJobId === "number") {
      return BigInt(rawJobId);
    }
  } catch {
    return null;
  }
  return null;
}

export function matchesJobEvent(
  event: Record<string, unknown>,
  contractId: string,
  jobId: bigint,
): boolean {
  const contract = event.contract ?? event.contract_id ?? event.contractId;
  const eventType = event.event_type ?? event.eventType ?? event.type;
  return (
    contract === contractId &&
    typeof eventType === "string" &&
    JOB_EVENT_TYPES.has(eventType) &&
    eventJobId(event) === jobId
  );
}
