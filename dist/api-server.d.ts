import * as http from 'node:http';
import { type PluginConfig } from './types.js';
export interface ApiServerOptions {
    host?: string;
    port?: number;
    config?: PluginConfig;
}
export declare function sanitizeUpstreamHeaders(headers: Headers): Headers;
export declare function chatCompletionsToResponsesPayload(payload: any): Record<string, unknown>;
export declare function responsesPayloadToChatCompletion(payload: any, fallbackModel?: string): Record<string, unknown>;
export declare function splitSseEvents(buffer: string): {
    events: string[];
    rest: string;
};
export declare function writeChatCompletionStreamResponse(res: http.ServerResponse, upstream: Response, fallbackModel?: string, includeUsage?: boolean): Promise<void>;
export declare function startApiServer(options?: ApiServerOptions): http.Server;
//# sourceMappingURL=api-server.d.ts.map