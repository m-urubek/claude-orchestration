import type { ChildProcess } from 'node:child_process';

// ─── Control State ───────────────────────────────────────────────────────────

export let pauseRequested: boolean = false;
export let hardStopRequested: boolean = false;
export let currentProcess: ChildProcess | null = null;

// ─── Control Functions ───────────────────────────────────────────────────────

/**
 * Request a soft pause. The pipeline will stop after the current agent completes.
 */
export function requestSoftPause(): void {
    pauseRequested = true;
}

/**
 * Request a hard stop. Kills the current agent process immediately.
 */
export function requestHardStop(): void {
    hardStopRequested = true;
    if (currentProcess && !currentProcess.killed) {
        currentProcess.kill('SIGTERM');
    }
}

/**
 * Reset all control flags. Called when starting a new pipeline run.
 */
export function reset(): void {
    pauseRequested = false;
    hardStopRequested = false;
    currentProcess = null;
}

/**
 * Set the current running process. Used by runner to track the active agent.
 */
export function setCurrentProcess(proc: ChildProcess | null): void {
    currentProcess = proc;
}

/**
 * Clear pause flags to resume the pipeline.
 */
export function clearPause(): void {
    pauseRequested = false;
    hardStopRequested = false;
}
