interface ProcRow {
    pid: number;
    ppid: number;
    cmd: string;
}

interface ProcNode extends ProcRow {
    depth: number;
}

interface WatchedResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stalled: boolean;
    ms: number;
    spawnError: Error | undefined;
}

interface WatchOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    label?: string;
    limitMs?: number;
    closeGraceMs?: number;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
    log?: (line: string) => void;
    list?: () => ProcRow[];
    killTree?: (rootPid: number, known: ProcNode[]) => void;
}

export const STALL_LIMIT_MS: number;
export function listProcesses(): ProcRow[];
export function descendantsOf(rootPid: number, rows: ProcRow[]): ProcNode[];
export function orphansRunning(execPath: string, rows: ProcRow[]): ProcRow[];
export function testFilesIn(procs: ProcNode[]): string[];
export function killProcessTree(rootPid: number, known?: ProcNode[]): void;
export function runWatched(command: string, args: string[], opts?: WatchOptions): Promise<WatchedResult>;
