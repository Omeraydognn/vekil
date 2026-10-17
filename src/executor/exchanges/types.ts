// Errors shared by the Exchange implementations (executor only).
export class OrderNotFoundError extends Error {
  override name = "OrderNotFoundError";
}
export class OrderRejectedError extends Error {
  override name = "OrderRejectedError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** OKX terminal order states (SPEC §14.2 step 6). */
export const TERMINAL_STATES = new Set(["filled", "canceled", "mmp_canceled"]);
export const OPEN_STATES = new Set(["live", "partially_filled"]);
