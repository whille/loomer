import express from "express";
import type { LoomerConfig, LoomerAppLike } from "./types/web.js";
export interface SseOptions {
    pollIntervalMs?: number;
    keepaliveIntervalMs?: number;
}
export declare function createApp(config?: LoomerConfig, loomerApp?: LoomerAppLike, sseOptions?: SseOptions): express.Express;
//# sourceMappingURL=web.d.ts.map