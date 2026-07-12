export class StorageV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageV2Error';
    this.code = code;
  }
}

export class StorageConflictError extends StorageV2Error {
  readonly resource: string;
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(
    resource: string,
    expectedRevision: number | null,
    actualRevision: number | null,
  ) {
    super(
      'STORAGE_CONFLICT',
      `Revision conflict for ${resource}: expected ${formatRevision(expectedRevision)}, actual ${formatRevision(actualRevision)}`,
    );
    this.name = 'StorageConflictError';
    this.resource = resource;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class StorageNotFoundError extends StorageV2Error {
  readonly resource: string;

  constructor(resource: string) {
    super('STORAGE_NOT_FOUND', `Storage resource not found: ${resource}`);
    this.name = 'StorageNotFoundError';
    this.resource = resource;
  }
}

export class StorageDataError extends StorageV2Error {
  constructor(message: string, options?: ErrorOptions) {
    super('STORAGE_DATA_INVALID', message, options);
    this.name = 'StorageDataError';
  }
}

export class StorageUnavailableError extends StorageV2Error {
  constructor(message: string, options?: ErrorOptions) {
    super('STORAGE_UNAVAILABLE', message, options);
    this.name = 'StorageUnavailableError';
  }
}

function formatRevision(revision: number | null): string {
  return revision === null ? '<absent>' : String(revision);
}
