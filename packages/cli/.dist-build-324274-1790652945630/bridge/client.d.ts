import { type RequestOptions } from "node:http";
import { type Json } from "./protocol.js";
export declare function hookRequest(route: string, data?: Json, options?: RequestOptions, timeout?: number): Promise<Json>;
