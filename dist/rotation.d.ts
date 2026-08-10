import type { AccountCredentials, DEFAULT_CONFIG } from './types.js';
export interface RotationResult {
    account: AccountCredentials;
    token: string;
    forceState?: {
        active: boolean;
        alias: string | null;
        remainingMs: number;
    };
}
export interface AccountSelectionContext {
    model?: string;
}
export declare function getNextAccount(config: typeof DEFAULT_CONFIG, selection?: AccountSelectionContext): Promise<RotationResult | null>;
export declare function markRateLimited(alias: string, rateLimitedUntil: number): void;
export declare function clearRateLimit(alias: string): void;
export declare function markModelUnsupported(alias: string, cooldownMs: number, info?: {
    model?: string;
    error?: string;
}): void;
export declare function clearModelUnsupported(alias: string): void;
export declare function markWorkspaceDeactivated(alias: string, cooldownMs: number, info?: {
    error?: string;
}): void;
export declare function clearWorkspaceDeactivated(alias: string): void;
export declare function markAuthInvalid(alias: string, expectedAccessToken: string): boolean;
export declare function clearAuthInvalid(alias: string, expectedAccessToken: string): boolean;
//# sourceMappingURL=rotation.d.ts.map