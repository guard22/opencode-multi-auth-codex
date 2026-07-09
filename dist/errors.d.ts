export type ErrorCode = 'NO_ELIGIBLE_ACCOUNTS' | 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_DISABLED' | 'TOKEN_REFRESH_FAILED' | 'STORE_LOCKED' | 'STORE_CORRUPTED' | 'STORE_MIGRATION_FAILED' | 'VALIDATION_ERROR' | 'RATE_LIMITED' | 'AUTH_INVALID' | 'MODEL_UNSUPPORTED' | 'WORKSPACE_DEACTIVATED' | 'MAX_RETRIES_EXCEEDED' | 'INVALID_REQUEST' | 'LOCALHOST_ONLY';
export interface DeterministicError {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
}
export declare function createError(code: ErrorCode, message: string, details?: Record<string, unknown>): DeterministicError;
export declare function errorResponse(error: DeterministicError, status?: number): Response;
export declare const Errors: {
    noEligibleAccounts: (reason?: string) => DeterministicError;
    accountNotFound: (alias: string) => DeterministicError;
    accountDisabled: (alias: string) => DeterministicError;
    maxRetriesExceeded: (attempts: number, aliasesTried: string[], details?: Record<string, unknown>) => DeterministicError;
    storeLocked: (reason?: string) => DeterministicError;
    localhostOnly: (host: string) => DeterministicError;
};
//# sourceMappingURL=errors.d.ts.map