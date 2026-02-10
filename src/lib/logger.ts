import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogEvent, LogLevel } from './types.js';

// Inline orchestrator root to avoid circular dependency with utils.ts
const ORCHESTRATOR_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// ─── Event Emitter for SSE Broadcasting ───────────────────────────────────────

export const emitter = new EventEmitter();

// Increase max listeners to support many SSE clients
emitter.setMaxListeners(100);

// ─── Logs Directory ───────────────────────────────────────────────────────────

function getLogsDir(): string {
    return path.join(ORCHESTRATOR_ROOT, 'logs');
}

function ensureLogsDir(): void {
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
}

// ─── Broadcast to SSE Clients ─────────────────────────────────────────────────

export function broadcast(event: LogEvent): void {
    emitter.emit('log', event);
}

// ─── Agent Logger ─────────────────────────────────────────────────────────────

export interface AgentLogger {
    logFile: string;
    write(text: string): void;
    close(): void;
}

export function createAgentLogger(agentName: string, invocationId: string): AgentLogger {
    ensureLogsDir();
    
    // Create log file: logs/2024-01-15T10-30-45-prd-generator.log
    const logFile = path.join(getLogsDir(), `${invocationId}-${agentName}.log`);
    const writeStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    return {
        logFile,
        write(text: string): void {
            // Write to file
            writeStream.write(text);
            
            // Broadcast to SSE clients
            broadcast({
                type: 'agent',
                agent: agentName,
                invocationId,
                message: text,
                timestamp: new Date().toISOString(),
            });
        },
        close(): void {
            writeStream.end();
        },
    };
}

// ─── Generate Invocation ID ──────────────────────────────────────────────────

export function generateInvocationId(): string {
    // Format: 2024-01-15T10-30-45
    return new Date().toISOString().slice(0, 19).replace(/:/g, '-');
}

// ─── Broadcast System Log ─────────────────────────────────────────────────────

export function broadcastLog(level: LogLevel, message: string): void {
    broadcast({
        type: 'system',
        level,
        message,
        timestamp: new Date().toISOString(),
    });
}
