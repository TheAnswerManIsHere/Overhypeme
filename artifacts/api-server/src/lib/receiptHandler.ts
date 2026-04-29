/**
 * Pure handler logic for GET /stripe/invoice/:invoiceId/receipt.
 *
 * Extracted from the route for testability — the route passes real deps;
 * tests pass fakes. The caller is responsible for the auth + ID-format
 * guards that fire before this function is invoked.
 */

export type ReceiptDeps = {
  /** Look up a user row by internal user ID. */
  getUserById: (id: string) => Promise<{ stripeCustomerId: string | null | undefined } | null>;
  /** Retrieve a Stripe invoice by its invoice ID. */
  retrieveInvoice: (
    invoiceId: string,
  ) => Promise<{ customer: string | { id: string } | null; hosted_invoice_url?: string | null }>;
};

export type ReceiptResult =
  | { type: "redirect"; url: string }
  | { type: "error"; status: number; message: string };

/**
 * Resolve a receipt redirect for the given user and invoice ID.
 *
 * Returns a redirect result with the hosted invoice URL when the invoice
 * belongs to the authenticated user, or an error result with the appropriate
 * HTTP status otherwise.
 */
export async function handleReceiptRequest(
  userId: string,
  invoiceId: string,
  deps: ReceiptDeps,
): Promise<ReceiptResult> {
  const user = await deps.getUserById(userId);
  if (!user?.stripeCustomerId) {
    return {
      type: "error",
      status: 404,
      message: "You don't have any invoices yet. Receipts will appear here once you make a purchase.",
    };
  }

  const invoice = await deps.retrieveInvoice(invoiceId);
  const invoiceCustomer =
    typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;

  if (invoiceCustomer !== user.stripeCustomerId) {
    return { type: "error", status: 403, message: "Forbidden" };
  }

  if (!invoice.hosted_invoice_url) {
    return { type: "error", status: 404, message: "No receipt available for this charge" };
  }

  return { type: "redirect", url: invoice.hosted_invoice_url };
}
