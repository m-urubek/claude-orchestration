import { spawn, execFileSync } from 'node:child_process';
import type { AgentInvocation, AgentSessionResult, ClaudeJsonResponse, PipelineConfig, AgentName } from './types.js';
import { log, saveState, getOrchestratorRoot } from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (opus can be slow)

function resolveTimeout(config: PipelineConfig): number {
    if (config.limits.agentTimeoutMinutes != null && config.limits.agentTimeoutMinutes > 0) {
        return config.limits.agentTimeoutMinutes * 60 * 1000;
    }
    return DEFAULT_TIMEOUT_MS;
}

// ─── JSON Schema Definitions ─────────────────────────────────────────────────

const JSON_SCHEMAS: Record<AgentName, Record<string, unknown>> = {
    'prd-generator': {
        type: 'object',
        properties: {
            success: { type: 'boolean' },
            sections: { type: 'array', items: { type: 'string' } },
        },
        required: ['success', 'sections'],
        additionalProperties: false,
    },
    'prd-analyzer': {
        type: 'object',
        properties: {
            needsClarification: { type: 'boolean' },
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        question: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['question', 'reason'],
                    additionalProperties: false,
                },
            },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
        },
        required: ['needsClarification', 'questions', 'confidence', 'reasoning'],
        additionalProperties: false,
    },
    'business-analyzer': {
        type: 'object',
        properties: {
            needsClarification: { type: 'boolean' },
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        question: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['question', 'reason'],
                    additionalProperties: false,
                },
            },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
        },
        required: ['needsClarification', 'questions', 'confidence', 'reasoning'],
        additionalProperties: false,
    },
    'clarification-answerer': {
        type: 'object',
        properties: {
            question: { type: 'string' },
            answer: { type: 'string' },
            confident: { type: 'boolean' },
            evidence: { type: 'string' },
        },
        required: ['question', 'answer', 'confident', 'evidence'],
        additionalProperties: false,
    },
    planner: {
        type: 'object',
        properties: {
            assignments: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        dependsOn: { type: 'array', items: { type: 'string' } },
                        estimatedFiles: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['id', 'title', 'description', 'dependsOn', 'estimatedFiles'],
                    additionalProperties: false,
                },
            },
        },
        required: ['assignments'],
        additionalProperties: false,
    },
    microplanner: {
        type: 'object',
        properties: {
            steps: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        description: { type: 'string' },
                        file: { type: 'string' },
                        action: { type: 'string', enum: ['modify', 'create', 'delete'] },
                    },
                    required: ['description', 'file', 'action'],
                    additionalProperties: false,
                },
            },
            considerations: { type: 'array', items: { type: 'string' } },
            filesToRead: { type: 'array', items: { type: 'string' } },
        },
        required: ['steps', 'considerations', 'filesToRead'],
        additionalProperties: false,
    },
    implementer: {
        type: 'object',
        properties: {
            filesModified: { type: 'array', items: { type: 'string' } },
            filesCreated: { type: 'array', items: { type: 'string' } },
            filesDeleted: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
            deviations: { type: 'array', items: { type: 'string' } },
        },
        required: ['filesModified', 'filesCreated', 'filesDeleted', 'summary', 'deviations'],
        additionalProperties: false,
    },
    verifier: {
        type: 'object',
        properties: {
            passed: { type: 'boolean' },
            issues: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        severity: { type: 'string', enum: ['error', 'warning'] },
                        file: { type: 'string' },
                        description: { type: 'string' },
                    },
                    required: ['severity', 'file', 'description'],
                    additionalProperties: false,
                },
            },
            buildPassed: { type: 'boolean' },
            buildOutput: { type: 'string' },
        },
        required: ['passed', 'issues', 'buildPassed', 'buildOutput'],
        additionalProperties: false,
    },
    'final-verifier': {
        type: 'object',
        properties: {
            passed: { type: 'boolean' },
            commitMessage: { type: 'string' },
            feedback: { type: 'string' },
            unmetRequirements: { type: 'array', items: { type: 'string' } },
        },
        required: ['passed', 'commitMessage', 'feedback', 'unmetRequirements'],
        additionalProperties: false,
    },
};

// ─── Build CLI Arguments ─────────────────────────────────────────────────────

function buildClaudeArgs(invocation: AgentInvocation): string[] {
    const args: string[] = ['-p', '--output-format', 'json'];

    // Agent
    args.push('--agent', invocation.agent);

    // Model
    if (invocation.model) {
        args.push('--model', invocation.model);
    }

    // Max turns (limits autonomous tool-call actions per session)
    if (invocation.maxTurns) {
        args.push('--max-turns', String(invocation.maxTurns));
    }

    // Budget cap
    if (invocation.maxBudgetUsd) {
        args.push('--max-budget-usd', String(invocation.maxBudgetUsd));
    }

    // Tool restrictions (read-only agents)
    if (invocation.tools && invocation.tools.length > 0) {
        args.push('--tools', ...invocation.tools);
    }

    // Allowed tools (auto-approve for unattended execution)
    if (invocation.allowedTools && invocation.allowedTools.length > 0) {
        args.push('--allowedTools', ...invocation.allowedTools);
    }

    // JSON schema for structured output
    const schema = invocation.jsonSchema;
    args.push('--json-schema', JSON.stringify(schema));

    // The prompt itself
    args.push(invocation.prompt);

    return args;
}

// ─── Build Resume CLI Arguments ──────────────────────────────────────────────

function buildResumeArgs(
    sessionId: string,
    prompt: string,
    jsonSchema: Record<string, unknown>
): string[] {
    const args: string[] = ['--resume', sessionId, '--output-format', 'json'];
    args.push('--json-schema', JSON.stringify(jsonSchema));
    args.push(prompt);
    return args;
}

// ─── Pre-flight Check ────────────────────────────────────────────────────────

let _claudeChecked = false;

export function checkClaudeCli(): void {
    if (_claudeChecked) return;
    try {
        const version = execFileSync('claude', ['--version'], {
            encoding: 'utf-8',
            timeout: 15_000,
        }).trim();
        log('info', `Claude CLI found: ${version}`);
        _claudeChecked = true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', `Claude CLI not found or not working: ${msg}`);
        log('error', 'Make sure "claude" is installed and in your PATH.');
        process.exit(1);
    }
}

// ─── Async Spawn Helper ──────────────────────────────────────────────────────

interface SpawnResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
}

function spawnClaude(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<SpawnResult> {
    return new Promise((resolve) => {
        const child = spawn('claude', args, {
            cwd: getOrchestratorRoot(),
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Close stdin immediately — we don't need to write to it,
        // but it must be a pipe (not /dev/null) or Claude CLI may hang.
        child.stdin.end();

        const stdoutChunks: Buffer[] = [];
        let stderrLines = '';
        let timedOut = false;
        const startTime = Date.now();

        // Log a periodic heartbeat so the user knows it's still alive
        const heartbeat = setInterval(() => {
            const elapsed = Math.round((Date.now() - startTime) / 60000);
            log('debug', `  [claude] still running... (${elapsed} min elapsed)`);
        }, 60_000);

        // Stream stderr to console in real-time (progress/status)
        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderrLines += text;
            // Show claude CLI stderr as debug output
            for (const line of text.split('\n').filter((l: string) => l.trim())) {
                log('debug', `  [claude] ${line.trim()}`);
            }
        });

        // Collect stdout (JSON response)
        child.stdout.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk);
        });

        // Total timeout — the only hard limit
        const totalTimer = setTimeout(() => {
            timedOut = true;
            const elapsed = Math.round((Date.now() - startTime) / 60000);
            log('error', `Claude process exceeded total timeout of ${Math.round(timeoutMs / 60000)} minutes (ran for ${elapsed} min) — killing`);
            child.kill('SIGTERM');
            setTimeout(() => {
                if (!child.killed) child.kill('SIGKILL');
            }, 5000);
        }, timeoutMs);

        child.on('close', (code, signal) => {
            clearTimeout(totalTimer);
            clearInterval(heartbeat);
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr: stderrLines,
                exitCode: code,
                signal: signal as string | null,
                timedOut,
            });
        });

        child.on('error', (err) => {
            clearTimeout(totalTimer);
            clearInterval(heartbeat);
            log('error', `Failed to spawn claude: ${err.message}`);
            resolve({
                stdout: '',
                stderr: err.message,
                exitCode: -1,
                signal: null,
                timedOut: false,
            });
        });
    });
}

// ─── Parse Claude Response ───────────────────────────────────────────────────

function parseClaudeResponse<T>(
    agent: string,
    result: SpawnResult,
    stateFile?: string,
): T {
    if (result.timedOut) {
        throw new Error(`Agent ${agent} timed out (exitCode=${result.exitCode}, signal=${result.signal})`);
    }

    if (result.exitCode !== 0) {
        const hint = result.stderr.slice(-500) || result.stdout.slice(-500) || '(no output)';
        throw new Error(
            `Agent ${agent} exited with code ${result.exitCode}${result.signal ? ` (signal: ${result.signal})` : ''}.\n` +
            `Last output: ${hint}`
        );
    }

    if (!result.stdout.trim()) {
        throw new Error(`Agent ${agent} produced no stdout output. stderr: ${result.stderr.slice(-300)}`);
    }

    // Parse the JSON response
    let response: ClaudeJsonResponse;
    try {
        response = JSON.parse(result.stdout) as ClaudeJsonResponse;
    } catch (parseErr) {
        // Show what we got for debugging
        const preview = result.stdout.slice(0, 500);
        throw new Error(
            `Agent ${agent}: failed to parse JSON response.\n` +
            `stdout preview: ${preview}\n` +
            `stderr: ${result.stderr.slice(-200)}`
        );
    }

    if (response.is_error) {
        throw new Error(`Agent ${agent} returned error: ${response.result}`);
    }

    // Log cost/duration if available
    if (response.cost_usd !== undefined) {
        log('debug', `  Agent ${agent}: cost=$${response.cost_usd.toFixed(4)}, turns=${response.num_turns}, duration=${Math.round(response.duration_ms / 1000)}s`);
    }

    // Extract structured output
    const structuredOutput = (response as Record<string, unknown>).structured_output as T;

    if (structuredOutput === undefined || structuredOutput === null) {
        // Fallback: try to parse the result field as JSON
        try {
            const parsed = JSON.parse(response.result) as T;
            log('warn', `Agent ${agent}: structured_output missing, parsed from result field`);
            if (stateFile) saveState(stateFile, parsed);
            return parsed;
        } catch {
            throw new Error(
                `Agent ${agent}: no structured_output and result is not valid JSON.\n` +
                `Result preview: ${response.result.slice(0, 300)}`
            );
        }
    }

    if (stateFile) {
        saveState(stateFile, structuredOutput);
    }

    return structuredOutput;
}

// ─── Run Agent ───────────────────────────────────────────────────────────────

export interface RunAgentOptions {
    config: PipelineConfig;
    stateFile?: string; // relative path to save structured output
    retries?: number;
    dryRun?: boolean;
    timeoutMs?: number;
}

export function getSchemaForAgent(agent: AgentName): Record<string, unknown> {
    return JSON_SCHEMAS[agent];
}

export async function runAgent<T>(invocation: AgentInvocation, options: RunAgentOptions): Promise<T> {
    const { config, stateFile, retries = 4, dryRun = false } = options;
    const timeoutMs = options.timeoutMs ?? resolveTimeout(config);

    checkClaudeCli();

    // Resolve model, maxTurns, and budget from config if not overridden
    const agentConfig = config.agents[invocation.agent];
    const model = invocation.model ?? agentConfig.model;
    const maxTurns = invocation.maxTurns ?? agentConfig.maxTurns;
    const maxBudgetUsd = invocation.maxBudgetUsd ?? agentConfig.maxBudgetUsd;

    // Fill in schema from registry if not provided
    const jsonSchema = Object.keys(invocation.jsonSchema).length > 0
        ? invocation.jsonSchema
        : JSON_SCHEMAS[invocation.agent];

    const fullInvocation: AgentInvocation = {
        ...invocation,
        model: model === 'inherit' ? undefined : model,
        maxTurns,
        maxBudgetUsd,
        jsonSchema,
    };

    const args = buildClaudeArgs(fullInvocation);

    log('info', `Running agent: ${invocation.agent} (model: ${model}, budget: $${maxBudgetUsd ?? 'unlimited'})`);
    log('debug', `Command: claude ${args.map((a) => (a.includes(' ') || a.includes('{') ? `'${a.slice(0, 80)}...'` : a)).join(' ')}`);

    if (dryRun) {
        log('info', `[DRY RUN] Would invoke agent ${invocation.agent}`);
        log('debug', `[DRY RUN] Prompt: ${invocation.prompt.slice(0, 200)}...`);
        const mockResult = createMockResult<T>(invocation.agent);
        if (stateFile) {
            saveState(stateFile, mockResult);
        }
        return mockResult;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            log('warn', `Retry ${attempt}/${retries} for agent ${invocation.agent}`);
        }

        try {
            const result = await spawnClaude(args, timeoutMs);
            const structuredOutput = parseClaudeResponse<T>(invocation.agent, result, stateFile);

            log('success', `Agent ${invocation.agent} completed successfully`);
            return structuredOutput;
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            log('error', `Agent ${invocation.agent} failed: ${lastError.message.slice(0, 500)}`);
        }
    }

    throw new Error(
        `Agent ${invocation.agent} failed after ${retries + 1} attempts: ${lastError?.message}`
    );
}

// ─── Run Agent With Session (returns session_id for reuse) ───────────────────

export async function runAgentWithSession<T>(
    invocation: AgentInvocation,
    options: RunAgentOptions
): Promise<AgentSessionResult<T>> {
    const { config, stateFile, retries = 4, dryRun = false } = options;
    const timeoutMs = options.timeoutMs ?? resolveTimeout(config);

    checkClaudeCli();

    // Resolve model, maxTurns, and budget from config if not overridden
    const agentConfig = config.agents[invocation.agent];
    const model = invocation.model ?? agentConfig.model;
    const maxTurns = invocation.maxTurns ?? agentConfig.maxTurns;
    const maxBudgetUsd = invocation.maxBudgetUsd ?? agentConfig.maxBudgetUsd;

    const jsonSchema = Object.keys(invocation.jsonSchema).length > 0
        ? invocation.jsonSchema
        : JSON_SCHEMAS[invocation.agent];

    const fullInvocation: AgentInvocation = {
        ...invocation,
        model: model === 'inherit' ? undefined : model,
        maxTurns,
        maxBudgetUsd,
        jsonSchema,
    };

    const args = buildClaudeArgs(fullInvocation);

    log('info', `Running agent (with session): ${invocation.agent} (model: ${model}, budget: $${maxBudgetUsd ?? 'unlimited'})`);

    if (dryRun) {
        log('info', `[DRY RUN] Would invoke agent ${invocation.agent} (with session)`);
        const mockResult = createMockResult<T>(invocation.agent);
        if (stateFile) saveState(stateFile, mockResult);
        return { result: mockResult, sessionId: 'dry-run-session-id' };
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            log('warn', `Retry ${attempt}/${retries} for agent ${invocation.agent} (session start)`);
        }

        try {
            const spawnResult = await spawnClaude(args, timeoutMs);

            if (spawnResult.timedOut) {
                throw new Error(`Agent ${invocation.agent} timed out`);
            }
            if (spawnResult.exitCode !== 0) {
                throw new Error(`Agent ${invocation.agent} exited with code ${spawnResult.exitCode}. stderr: ${spawnResult.stderr.slice(-300)}`);
            }

            const response = JSON.parse(spawnResult.stdout) as ClaudeJsonResponse;

            if (response.is_error) {
                throw new Error(`Agent ${invocation.agent} returned error: ${response.result}`);
            }

            if (response.cost_usd !== undefined) {
                log('debug', `  Agent ${invocation.agent}: cost=$${response.cost_usd.toFixed(4)}, turns=${response.num_turns}, duration=${Math.round(response.duration_ms / 1000)}s`);
            }

            const structuredOutput = (response as Record<string, unknown>).structured_output as T;
            const sessionId = response.session_id;

            if (!sessionId) {
                throw new Error(`Agent ${invocation.agent}: no session_id in response`);
            }

            if (structuredOutput === undefined || structuredOutput === null) {
                try {
                    const parsed = JSON.parse(response.result) as T;
                    log('warn', `Agent ${invocation.agent}: structured_output missing, parsed from result field`);
                    if (stateFile) saveState(stateFile, parsed);
                    return { result: parsed, sessionId };
                } catch {
                    throw new Error(
                        `Agent ${invocation.agent}: no structured_output and result is not valid JSON`
                    );
                }
            }

            log('success', `Agent ${invocation.agent} session started: ${sessionId.slice(0, 12)}...`);
            if (stateFile) saveState(stateFile, structuredOutput);

            return { result: structuredOutput, sessionId };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            log('error', `Agent ${invocation.agent} failed: ${lastError.message.slice(0, 500)}`);
        }
    }

    throw new Error(
        `Agent ${invocation.agent} failed after ${retries + 1} attempts: ${lastError?.message}`
    );
}

// ─── Resume Agent Session ────────────────────────────────────────────────────

export async function resumeAgent<T>(
    sessionId: string,
    prompt: string,
    jsonSchema: Record<string, unknown>,
    options: RunAgentOptions
): Promise<AgentSessionResult<T>> {
    const { dryRun = false, stateFile, retries = 4 } = options;
    const timeoutMs = options.timeoutMs ?? resolveTimeout(options.config);

    const args = buildResumeArgs(sessionId, prompt, jsonSchema);

    log('info', `Resuming session ${sessionId.slice(0, 12)}...`);

    if (dryRun) {
        log('info', `[DRY RUN] Would resume session ${sessionId.slice(0, 12)}...`);
        const mockResult = {
            question: 'Mock question',
            answer: 'Dry run — mock answer',
            confident: true,
            evidence: 'Dry run',
        } as unknown as T;
        if (stateFile) saveState(stateFile, mockResult);
        return { result: mockResult, sessionId };
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            log('warn', `Retry ${attempt}/${retries} for session resume ${sessionId.slice(0, 12)}...`);
        }

        try {
            const spawnResult = await spawnClaude(args, timeoutMs);

            if (spawnResult.timedOut) {
                throw new Error(`Session resume timed out`);
            }
            if (spawnResult.exitCode !== 0) {
                throw new Error(`Session resume exited with code ${spawnResult.exitCode}. stderr: ${spawnResult.stderr.slice(-300)}`);
            }

            const response = JSON.parse(spawnResult.stdout) as ClaudeJsonResponse;

            if (response.is_error) {
                throw new Error(`Session resume returned error: ${response.result}`);
            }

            if (response.cost_usd !== undefined) {
                log('debug', `  Session resume: cost=$${response.cost_usd.toFixed(4)}, turns=${response.num_turns}, duration=${Math.round(response.duration_ms / 1000)}s`);
            }

            const structuredOutput = (response as Record<string, unknown>).structured_output as T;
            const newSessionId = response.session_id || sessionId;

            if (structuredOutput === undefined || structuredOutput === null) {
                try {
                    const parsed = JSON.parse(response.result) as T;
                    log('warn', `Session resume: structured_output missing, parsed from result field`);
                    if (stateFile) saveState(stateFile, parsed);
                    return { result: parsed, sessionId: newSessionId };
                } catch {
                    throw new Error(
                        `Session resume: no structured_output and result is not valid JSON`
                    );
                }
            }

            log('success', `Session ${sessionId.slice(0, 12)}... resumed successfully`);
            if (stateFile) saveState(stateFile, structuredOutput);

            return { result: structuredOutput, sessionId: newSessionId };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            log('error', `Session resume failed: ${lastError.message.slice(0, 500)}`);
        }
    }

    throw new Error(
        `Session resume failed after ${retries + 1} attempts: ${lastError?.message}`
    );
}

// ─── Mock Results for Dry Run ────────────────────────────────────────────────

function createMockResult<T>(agent: AgentName): T {
    const mocks: Record<AgentName, unknown> = {
        'prd-generator': { success: true, sections: ['Overview', 'Requirements', 'Acceptance Criteria', 'Constraints', 'Out of Scope'] },
        'prd-analyzer': { needsClarification: false, questions: [], confidence: 9, reasoning: 'Dry run - PRD looks complete' },
        'business-analyzer': { needsClarification: false, questions: [], confidence: 9, reasoning: 'Dry run — business requirements look clear' },
        'clarification-answerer': { question: 'Mock question', answer: 'Dry run — mock answer', confident: true, evidence: 'Dry run' },
        planner: {
            assignments: [
                {
                    id: 'assignment-1',
                    title: 'Mock Assignment',
                    description: 'This is a dry run mock assignment',
                    dependsOn: [],
                    estimatedFiles: ['src/main.ts'],
                },
            ],
        },
        microplanner: { steps: [{ description: 'Mock step', file: 'src/main.ts', action: 'modify' }], considerations: [], filesToRead: [] },
        implementer: { filesModified: [], filesCreated: [], filesDeleted: [], summary: 'Dry run - no changes', deviations: [] },
        verifier: { passed: true, issues: [], buildPassed: true, buildOutput: 'Dry run - skipped' },
        'final-verifier': { passed: true, commitMessage: 'feat: dry run', feedback: '', unmetRequirements: [] },
    };
    return mocks[agent] as T;
}
