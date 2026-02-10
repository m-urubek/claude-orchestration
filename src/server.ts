#!/usr/bin/env npx tsx

import express from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { exec } from 'node:child_process';
import { emitter, broadcast } from './lib/logger.js';
import { 
    requestSoftPause, 
    requestHardStop, 
    reset as resetControl,
    clearPause,
    pauseRequested,
    hardStopRequested,
} from './lib/control.js';
import { 
    loadPipelineState, 
    getOrchestratorRoot,
} from './lib/utils.js';
import type { LogEvent } from './lib/types.js';

const app = express();
const PORT = process.env.PORT || 3456;

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json());

// Serve static files from ui/dist in production
const uiDistPath = path.join(getOrchestratorRoot(), 'ui', 'dist');
if (fs.existsSync(uiDistPath)) {
    app.use(express.static(uiDistPath));
}

// ─── SSE Endpoint ────────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    
    // Send initial connection message
    const connectEvent: LogEvent = {
        type: 'system',
        level: 'info',
        message: 'Connected to pipeline monitor',
        timestamp: new Date().toISOString(),
    };
    res.write(`data: ${JSON.stringify(connectEvent)}\n\n`);

    // Send current status
    const state = loadPipelineState();
    if (state) {
        const statusEvent: LogEvent = {
            type: 'system',
            level: 'info',
            message: `Pipeline status: ${state.phase}`,
            timestamp: new Date().toISOString(),
        };
        res.write(`data: ${JSON.stringify(statusEvent)}\n\n`);
    }

    // Handler for log events
    const onLog = (event: LogEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    emitter.on('log', onLog);

    // Clean up on client disconnect
    req.on('close', () => {
        emitter.off('log', onLog);
    });
});

// ─── Control Endpoints ───────────────────────────────────────────────────────

// Start pipeline
app.post('/api/start', (req, res) => {
    const { task, mode = 'autonomous', projectDir, stopAfterPrd = false } = req.body;
    
    if (!task || !projectDir) {
        res.status(400).json({ error: 'task and projectDir are required' });
        return;
    }

    // Reset control state
    resetControl();
    
    // Build command arguments
    const args = [
        'tsx', 'src/orchestrate.ts',
        '--mode', mode,
        '--project-dir', projectDir,
    ];
    
    if (stopAfterPrd) {
        args.push('--stop-after-prd');
    }
    
    args.push(task);

    broadcast({
        type: 'system',
        level: 'phase',
        message: `Starting pipeline: ${task.slice(0, 100)}...`,
        timestamp: new Date().toISOString(),
    });

    // Spawn the pipeline process (don't wait for it)
    const child = exec(args.join(' '), {
        cwd: getOrchestratorRoot(),
        env: process.env,
    });

    child.stdout?.on('data', (data: string) => {
        broadcast({
            type: 'system',
            level: 'info',
            message: data.trim(),
            timestamp: new Date().toISOString(),
        });
    });

    child.stderr?.on('data', (data: string) => {
        broadcast({
            type: 'system',
            level: 'debug',
            message: data.trim(),
            timestamp: new Date().toISOString(),
        });
    });

    child.on('close', (code) => {
        broadcast({
            type: 'system',
            level: code === 0 ? 'success' : 'error',
            message: `Pipeline exited with code ${code}`,
            timestamp: new Date().toISOString(),
        });
    });

    res.json({ status: 'started', pid: child.pid });
});

// Resume pipeline
app.post('/api/resume', (_req, res) => {
    clearPause();

    const args = ['tsx', 'src/orchestrate.ts', '--resume'];

    broadcast({
        type: 'system',
        level: 'phase',
        message: 'Resuming pipeline...',
        timestamp: new Date().toISOString(),
    });

    const child = exec(args.join(' '), {
        cwd: getOrchestratorRoot(),
        env: process.env,
    });

    child.stdout?.on('data', (data: string) => {
        broadcast({
            type: 'system',
            level: 'info',
            message: data.trim(),
            timestamp: new Date().toISOString(),
        });
    });

    child.stderr?.on('data', (data: string) => {
        broadcast({
            type: 'system',
            level: 'debug',
            message: data.trim(),
            timestamp: new Date().toISOString(),
        });
    });

    child.on('close', (code) => {
        broadcast({
            type: 'system',
            level: code === 0 ? 'success' : 'error',
            message: `Pipeline exited with code ${code}`,
            timestamp: new Date().toISOString(),
        });
    });

    res.json({ status: 'resumed', pid: child.pid });
});

// Soft pause (wait for current agent to finish)
app.post('/api/pause', (_req, res) => {
    requestSoftPause();
    
    broadcast({
        type: 'system',
        level: 'warn',
        message: 'Soft pause requested - will stop after current agent completes',
        timestamp: new Date().toISOString(),
    });

    res.json({ status: 'pause_requested' });
});

// Hard stop (kill current agent process)
app.post('/api/stop', (_req, res) => {
    requestHardStop();
    
    broadcast({
        type: 'system',
        level: 'error',
        message: 'Hard stop requested - killing current agent process',
        timestamp: new Date().toISOString(),
    });

    res.json({ status: 'stop_requested' });
});

// Reset state directory
app.post('/api/reset', (_req, res) => {
    const stateDir = path.join(getOrchestratorRoot(), 'state');
    
    try {
        if (fs.existsSync(stateDir)) {
            fs.rmSync(stateDir, { recursive: true });
        }
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(path.join(stateDir, 'assignments'), { recursive: true });
        
        resetControl();

        broadcast({
            type: 'system',
            level: 'success',
            message: 'State directory cleared',
            timestamp: new Date().toISOString(),
        });

        res.json({ status: 'reset_complete' });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});

// Get current pipeline status
app.get('/api/status', (_req, res) => {
    const state = loadPipelineState();
    res.json({
        state,
        pauseRequested,
        hardStopRequested,
    });
});

// Open logs folder
app.get('/api/open-logs', (_req, res) => {
    const logsDir = path.join(getOrchestratorRoot(), 'logs');
    
    // Ensure logs dir exists
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }

    // Use 'open' command on macOS
    exec(`open "${logsDir}"`, (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ status: 'opened', path: logsDir });
        }
    });
});

// ─── Fallback to SPA ─────────────────────────────────────────────────────────

// Express 5 requires named parameters for wildcards
app.get('/{*splat}', (_req, res) => {
    const indexPath = path.join(uiDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('UI not built. Run: npm run build:ui');
    }
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n\x1b[36m\x1b[1m╔══════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[36m\x1b[1m║      Pipeline Monitor Server              ║\x1b[0m`);
    console.log(`\x1b[36m\x1b[1m╚══════════════════════════════════════════╝\x1b[0m\n`);
    console.log(`  Server running at: \x1b[32mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`  API endpoints:`);
    console.log(`    GET  /api/stream   - SSE log stream`);
    console.log(`    GET  /api/status   - Current pipeline state`);
    console.log(`    POST /api/start    - Start new pipeline`);
    console.log(`    POST /api/resume   - Resume pipeline`);
    console.log(`    POST /api/pause    - Soft pause`);
    console.log(`    POST /api/stop     - Hard stop`);
    console.log(`    POST /api/reset    - Clear state directory`);
    console.log(`    GET  /api/open-logs - Open logs folder`);
    console.log();
});
