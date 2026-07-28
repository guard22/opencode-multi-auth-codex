import type { AccountCredentials } from './types.js';
export interface AuthorizationFlow {
    pkce: {
        verifier: string;
        challenge: string;
    };
    state: string;
    url: string;
    redirectUri: string;
    port: number;
}
export interface LoginAccountOptions {
    timeoutMs?: number;
    callbackUrl?: Promise<string>;
}
export declare function createAuthorizationFlow(port?: number): Promise<AuthorizationFlow>;
export declare function validateAuthorizationCallback(flow: AuthorizationFlow, callbackUrl: string): string;
export declare function loginAccount(alias: string, flow?: AuthorizationFlow, options?: LoginAccountOptions): Promise<AccountCredentials>;
export declare function refreshToken(alias: string): Promise<AccountCredentials | null>;
export declare function ensureValidToken(alias: string): Promise<string | null>;
//# sourceMappingURL=auth.d.ts.map