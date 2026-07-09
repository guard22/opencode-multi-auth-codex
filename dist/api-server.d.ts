import * as http from 'node:http';
import { type PluginConfig } from './types.js';
export interface ApiServerOptions {
    host?: string;
    port?: number;
    config?: PluginConfig;
}
export declare function chatCompletionsToResponsesPayload(payload: any): Record<string, unknown>;
export declare function responsesPayloadToChatCompletion(payload: any, fallbackModel?: string): Record<string, unknown>;
export declare function startApiServer(options?: ApiServerOptions): http.Server;
//# sourceMappingURL=api-server.d.ts.map