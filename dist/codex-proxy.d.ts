import { type PluginConfig } from './types.js';
export declare const DEFAULT_LATEST_CODEX_MODEL = "gpt-5.5";
export declare const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export interface CodexProxyOptions {
    config?: PluginConfig;
}
export declare function extractPathAndSearch(url: string): string;
export declare function toCodexBackendUrl(originalUrl: string): string;
export declare function filterInput(input: unknown): unknown;
export declare function normalizeResponsesTools(tools: unknown): unknown;
export declare function normalizeModel(model: string | undefined): string;
export declare function supportsFastMode(model: string | undefined): boolean;
export declare function isCyberPolicyError(payload: any, fallbackText?: string): boolean;
export declare function handleCodexProxyRequest(input: Request | string | URL, init?: RequestInit, options?: CodexProxyOptions): Promise<Response>;
//# sourceMappingURL=codex-proxy.d.ts.map