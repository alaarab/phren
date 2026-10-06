type LogLevel = "debug" | "info" | "warn" | "error";
export declare function log(level: LogLevel, tool: string, message: string, extra?: object): void;
export declare const logger: {
    debug: (tool: string, message: string, extra?: object) => void;
    info: (tool: string, message: string, extra?: object) => void;
    warn: (tool: string, message: string, extra?: object) => void;
    error: (tool: string, message: string, extra?: object) => void;
};
export {};
