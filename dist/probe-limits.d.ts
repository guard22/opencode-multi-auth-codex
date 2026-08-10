import type { AccountCredentials, AccountRateLimits } from './types.js';
export interface ProbeResult {
    rateLimits?: AccountRateLimits;
    eventTs?: number;
    sourceFile?: string;
    probeModel?: string;
    probeEffort?: string;
    probeDurationMs?: number;
    error?: string;
    isAuthoritative?: boolean;
}
export declare function syncAccountTokensFromProbeHome(alias: string, codexHome: string, expectedAccessToken: string, expectedRefreshToken: string): boolean;
export declare function shouldRetryWithFallback(error?: string): boolean;
export declare function getProbeEffort(): string;
export declare function getProbeModels(): string[];
export declare function probeRateLimitsForAccount(account: AccountCredentials): Promise<ProbeResult>;
export declare function getProbeHomeRoot(): string;
//# sourceMappingURL=probe-limits.d.ts.map