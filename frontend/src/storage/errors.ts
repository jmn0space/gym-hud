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
