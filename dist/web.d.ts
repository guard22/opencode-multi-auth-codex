import * as http from 'node:http';
export declare function isLocalhostHost(host: string): boolean;
export declare function isWebHostAllowed(host: string): boolean;
export declare function startWebConsole(options?: {
    port?: number;
    host?: string;
}): http.Server;
//# sourceMappingURL=web.d.ts.map