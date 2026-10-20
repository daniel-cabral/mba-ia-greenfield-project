export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoUploadTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_TOO_LARGE',
      400,
      'Video exceeds the maximum upload size',
    );
  }
}

export class VideoInvalidPartException extends DomainException {
  constructor() {
    super('VIDEO_INVALID_PART', 400, 'Invalid part number');
  }
}

export class VideoUploadIncompleteException extends DomainException {
  constructor() {
    super('VIDEO_UPLOAD_INCOMPLETE', 400, 'Upload has missing parts');
  }
}

export class VideoNotDraftException extends DomainException {
  constructor() {
    super('VIDEO_NOT_DRAFT', 409, 'Video is not accepting uploads');
  }
}

export class VideoUploadExpiredException extends DomainException {
  constructor() {
    super('VIDEO_UPLOAD_EXPIRED', 409, 'Upload expired, create a new video');
  }
}

export class VideoAlreadyFinalizedException extends DomainException {
  constructor() {
    super('VIDEO_ALREADY_FINALIZED', 409, 'Video upload is already finalized');
  }
}
