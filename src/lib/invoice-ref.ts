// Customer-facing, Leadey-branded invoice/payment references. Shared by the
// customer billing endpoints and the platform-admin endpoints so both show the
// SAME reference — when a customer quotes "LEA-HYRRA-0001", admin can match it.

/** Short uppercase org code — the org name's first word capped at 6 chars
 *  (e.g. "Hyrra LTD" → "HYRRA", "Octogle Technologies" → "OCTOGL"). */
export function orgCode(name: string | null | undefined): string {
  const firstWord = (name || "").trim().split(/\s+/)[0] || "";
  return firstWord.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6) || "ORG";
}

/** Reference for a Stripe subscription invoice: reuses Stripe's per-customer
 *  sequence suffix so it's stable and deterministic. → "LEA-HYRRA-0001". */
export function subscriptionRef(
  orgName: string | null | undefined,
  stripeNumber: string | null | undefined,
  stripeId: string,
): string {
  const seqRaw =
    (stripeNumber && stripeNumber.match(/(\d+)\s*$/)?.[1]) ||
    stripeId.replace(/[^0-9]/g, "").slice(-4) ||
    "1";
  return `LEA-${orgCode(orgName)}-${seqRaw.padStart(4, "0")}`;
}

/** Reference for a Stripe one-off / top-up PaymentIntent. → "LEA-HYRRA-SKS7U". */
export function topupRef(orgName: string | null | undefined, paymentIntentId: string): string {
  const suffix = paymentIntentId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(-5);
  return `LEA-${orgCode(orgName)}-${suffix}`;
}
