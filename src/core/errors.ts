// Errors core throws to the server; `status` is the HTTP status the server answers with.
export class CoreError extends Error {
  override name = "CoreError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A cycle is already running (HTTP 409). */
export class BusyError extends CoreError {
  override name = "BusyError";
  constructor() {
    super(409, "Bir döngü zaten çalışıyor");
  }
}
