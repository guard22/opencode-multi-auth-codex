export type ErrorCode =
  | 'NO_ELIGIBLE_ACCOUNTS'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_DISABLED'
  | 'TOKEN_REFRESH_FAILED'
  | 'STORE_LOCKED'
  | 'STORE_CORRUPTED'
  | 'STORE_MIGRATION_FAILED'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'AUTH_INVALID'
  | 'MODEL_UNSUPPORTED'
  | 'WORKSPACE_DEACTIVATED'
  | 'MAX_RETRIES_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'LOCALHOST_ONLY'

export interface DeterministicError {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

export function createError(code: ErrorCode, message: string, details?: Record<string, unknown>): DeterministicError {
  return { code, message, details }
}

export function errorResponse(error: DeterministicError, status: number = 500): Response {
  return new Response(
    JSON.stringify({ error }),
    { status, headers: { 'Content-Type': 'application/json' } }
  )
}

export const Errors = {
  noEligibleAccounts: (reason?: string): DeterministicError => ({
    code: 'NO_ELIGIBLE_ACCOUNTS',
    message: reason || 'No eligible accounts available for rotation',
  }),
  accountNotFound: (alias: string): DeterministicError => ({
    code: 'ACCOUNT_NOT_FOUND',
    message: `Account not found: ${alias}`,
    details: { alias },
  }),
  accountDisabled: (alias: string): DeterministicError => ({
    code: 'ACCOUNT_DISABLED',
    message: `Account is disabled: ${alias}`,
    details: { alias },
  }),
  maxRetriesExceeded: (
    attempts: number,
    aliasesTried: string[],
    details?: Record<string, unknown>
  ): DeterministicError => ({
    code: 'MAX_RETRIES_EXCEEDED',
    message: `Exhausted all ${attempts} retry attempts`,
    details: { attempts, aliasesTried, ...details },
  }),
  storeLocked: (reason?: string): DeterministicError => ({
    code: 'STORE_LOCKED',
    message: reason || 'Store is locked and cannot be modified',
  }),
  localhostOnly: (host: string): DeterministicError => ({
    code: 'LOCALHOST_ONLY',
    message: 'Dashboard can only bind to localhost (127.0.0.1 or ::1)',
    details: { attemptedHost: host },
  }),
}
