export function createError(code, message, details) {
    return { code, message, details };
}
export function errorResponse(error, status = 500) {
    return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
}
export const Errors = {
    noEligibleAccounts: (reason) => ({
        code: 'NO_ELIGIBLE_ACCOUNTS',
        message: reason || 'No eligible accounts available for rotation',
    }),
    accountNotFound: (alias) => ({
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account not found: ${alias}`,
        details: { alias },
    }),
    accountDisabled: (alias) => ({
        code: 'ACCOUNT_DISABLED',
        message: `Account is disabled: ${alias}`,
        details: { alias },
    }),
    maxRetriesExceeded: (attempts, aliasesTried, details) => ({
        code: 'MAX_RETRIES_EXCEEDED',
        message: `Exhausted all ${attempts} retry attempts`,
        details: { attempts, aliasesTried, ...details },
    }),
    storeLocked: (reason) => ({
        code: 'STORE_LOCKED',
        message: reason || 'Store is locked and cannot be modified',
    }),
    localhostOnly: (host) => ({
        code: 'LOCALHOST_ONLY',
        message: 'Dashboard can only bind to localhost (127.0.0.1 or ::1)',
        details: { attemptedHost: host },
    }),
};
//# sourceMappingURL=errors.js.map