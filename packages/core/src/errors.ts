export type ErrorCode =
  | 'E_CONFIG_NOT_FOUND'
  | 'E_CONFIG_INVALID'
  | 'E_ACK_REQUIRED'
  | 'E_HOSTS_UNCONFIRMED'
  | 'E_AUTH_FAILED'
  | 'E_NAVIGATION_BLOCKED'
  | 'E_RUN_FAILED';

export class LookoverError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'LookoverError';
  }
}
