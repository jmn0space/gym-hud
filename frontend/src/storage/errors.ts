export class LocalStorageError extends Error {
  override readonly name: string = "LocalStorageError";
}

export class InvalidActionError extends LocalStorageError {
  override readonly name = "InvalidActionError";
}

export class ActionConflictError extends LocalStorageError {
  override readonly name = "ActionConflictError";
}

export class PreconditionFailedError extends LocalStorageError {
  override readonly name = "PreconditionFailedError";
}

export class ActiveSessionConflictError extends LocalStorageError {
  override readonly name = "ActiveSessionConflictError";
}

export class RecordNotFoundError extends LocalStorageError {
  override readonly name = "RecordNotFoundError";
}

export class StorageCorruptionError extends LocalStorageError {
  override readonly name = "StorageCorruptionError";
}

/**
 * Thrown when a local write fails because the underlying IndexedDB request or
 * transaction failed with a `QuotaExceededError` DOMException (the device or
 * origin storage quota was reached). The original DOMException is always
 * preserved as `cause` so callers can distinguish this from other storage
 * failures by walking the cause chain, without depending on this class alone.
 */
export class StorageQuotaExceededError extends LocalStorageError {
  override readonly name = "StorageQuotaExceededError";
}
