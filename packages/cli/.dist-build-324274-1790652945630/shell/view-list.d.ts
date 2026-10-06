export declare function formatSelectableLine(line: string, cols: number, selected: boolean): string;
export declare function viewportWithStatus(allLines: string[], cursorFirstLine: number, cursorLastLine: number, usableHeight: number, previousScroll: number, currentIndex: number, totalItems: number): {
    lines: string[];
    scrollStart: number;
};
