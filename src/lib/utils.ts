import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
import type { PipelineConfig, PipelineState, ClarificationEntry } from './types.js';
import { broadcastLog } from './logger.js';

// ─── Path Resolution ─────────────────────────────────────────────────────────

// ORCHESTRATOR_ROOT = where the orchestrator's own files live (config.json, src/)
// Resolved from the script's location: __dirname is src/lib/, so go up twice.
const ORCHESTRATOR_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CONFIG_PATH = path.join(ORCHESTRATOR_ROOT, 'config.json');

// PROJECT_DIR = the target project directory where agents read/write code.
// Set via setProjectDir() before the pipeline starts.
let _projectDir: string | null = null;

export function setProjectDir(dir: string): void {
    _projectDir = path.resolve(dir);
}

export function getProjectDir(): string {
    if (!_projectDir) {
        throw new Error('Project directory not set. Call setProjectDir() or pass --project-dir.');
    }
    return _projectDir;
}

export function getOrchestratorRoot(): string {
    return ORCHESTRATOR_ROOT;
}

// State lives in the orchestrator repo (state/ next to config.json)
function getStateDir(): string {
    return path.join(ORCHESTRATOR_ROOT, 'state');
}

export async function promptForProjectDir(): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log(`\n${colors.cyan}${colors.bold}Where is the project you want to work on?${colors.reset}`);
        console.log(`${colors.dim}Enter the absolute path to the project directory:${colors.reset}`);
        rl.question(`${colors.green}> ${colors.reset}`, (answer) => {
            rl.close();
            const resolved = path.resolve(answer.trim());
            if (!fs.existsSync(resolved)) {
                log('error', `Directory does not exist: ${resolved}`);
                process.exit(1);
            }
            resolve(resolved);
        });
    });
}

/**
 * Wraps an agent prompt with project directory context.
 * Agents spawned from the orchestrator root need explicit instructions
 * to use absolute paths when working on the target project's files.
 */
export function wrapPromptWithProjectDir(prompt: string): string {
    const projectDir = getProjectDir();
    return `[PROJECT DIRECTORY]
The target project you are working on is located at: ${projectDir}
All file operations on the project codebase (reading source code, writing/editing files, running git commands, running build commands) MUST use absolute paths under: ${projectDir}
State files (state/prd.md, state/task.md, etc.) are in the current working directory — reference them with relative paths as usual.
[END PROJECT DIRECTORY]

${prompt}`;
}

// ─── Colors ──────────────────────────────────────────────────────────────────

const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'phase' | 'debug';

const levelColors: Record<LogLevel, string> = {
    info: colors.blue,
    success: colors.green,
    warn: colors.yellow,
    error: colors.red,
    phase: colors.magenta,
    debug: colors.dim,
};

const levelLabels: Record<LogLevel, string> = {
    info: 'INFO',
    success: ' OK ',
    warn: 'WARN',
    error: 'ERR ',
    phase: '>>>>',
    debug: 'DBG ',
};

export function log(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    const color = levelColors[level];
    const label = levelLabels[level];
    console.log(`${colors.dim}[${timestamp}]${colors.reset} ${color}${colors.bold}${label}${colors.reset} ${message}`);
    
    // Broadcast to SSE clients
    broadcastLog(level, message);
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export function checkGitClean(): void {
    const projectDir = getProjectDir();
    try {
        const status = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8' }).trim();
        // Filter out .claude/ files since the entire directory is gitignored
        const significantChanges = status
            .split('\n')
            .filter((line) => line.trim() !== '')
            .filter((line) => !line.includes('.claude/'));

        if (significantChanges.length > 0) {
            log('warn', 'Working tree has uncommitted changes:');
            for (const line of significantChanges) {
                console.log(`  ${line}`);
            }
            log('warn', 'Consider committing or stashing changes before running the pipeline.');
        }
    } catch {
        log('error', `Failed to check git status in ${projectDir}. Is it a git repository?`);
        process.exit(1);
    }
}

export function getGitDiff(): string {
    try {
        return execSync('git diff', { cwd: getProjectDir(), encoding: 'utf-8' });
    } catch {
        return '';
    }
}

// ─── Config ──────────────────────────────────────────────────────────────────

export function loadConfig(): PipelineConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
        log('error', `Pipeline config not found at ${CONFIG_PATH}`);
        process.exit(1);
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as PipelineConfig;
}

// ─── State Directory ─────────────────────────────────────────────────────────

export function ensureStateDir(): void {
    const stateDir = getStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'assignments'), { recursive: true });
}

export function ensureAssignmentDir(assignmentId: string): void {
    fs.mkdirSync(path.join(getStateDir(), 'assignments', assignmentId), { recursive: true });
}

// ─── State File I/O ──────────────────────────────────────────────────────────

export function statePath(...segments: string[]): string {
    return path.join(getStateDir(), ...segments);
}

export function saveState<T>(relativePath: string, data: T): void {
    const fullPath = statePath(relativePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadState<T>(relativePath: string): T | null {
    const fullPath = statePath(relativePath);
    if (!fs.existsSync(fullPath)) return null;
    const raw = fs.readFileSync(fullPath, 'utf-8');
    return JSON.parse(raw) as T;
}

export function saveTextState(relativePath: string, text: string): void {
    const fullPath = statePath(relativePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, text, 'utf-8');
}

export function loadTextState(relativePath: string): string | null {
    const fullPath = statePath(relativePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf-8');
}

// ─── Pipeline State ──────────────────────────────────────────────────────────

const PIPELINE_STATE_FILE = 'pipeline-state.json';

export function initPipelineState(mode: string, stopAfterPrd: boolean): PipelineState {
    const state: PipelineState = {
        phase: 'init',
        mode,
        projectDir: getProjectDir(),
        stopAfterPrd,
        completedAssignments: [],
        currentAssignmentId: null,
        clarificationRound: 0,
        pipelineIteration: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    saveState(PIPELINE_STATE_FILE, state);
    return state;
}

export function loadPipelineState(): PipelineState | null {
    return loadState<PipelineState>(PIPELINE_STATE_FILE);
}

export function updatePipelineState(updates: Partial<PipelineState>): PipelineState {
    const current = loadPipelineState();
    if (!current) {
        throw new Error('Pipeline state not initialized');
    }
    const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
    saveState(PIPELINE_STATE_FILE, updated);
    return updated;
}

// ─── User Interaction ────────────────────────────────────────────────────────

export async function promptUser(
    questions: Array<{ question: string; reason: string }>
): Promise<Array<{ question: string; answer: string }>> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const askQuestion = (prompt: string): Promise<string> => {
        return new Promise((resolve) => {
            rl.question(prompt, (answer) => {
                resolve(answer.trim());
            });
        });
    };

    const answers: Array<{ question: string; answer: string }> = [];

    console.log('\n' + colors.cyan + colors.bold + '═══ Clarification Needed ═══' + colors.reset + '\n');

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        console.log(`${colors.yellow}Question ${i + 1}/${questions.length}:${colors.reset}`);
        console.log(`  ${q.question}`);
        console.log(`  ${colors.dim}Reason: ${q.reason}${colors.reset}`);
        const answer = await askQuestion(`${colors.green}> ${colors.reset}`);
        answers.push({ question: q.question, answer });
        console.log();
    }

    rl.close();
    return answers;
}

// ─── Task Description ────────────────────────────────────────────────────────

export function getTaskDescription(args: string[]): string | null {
    // Check for --task-file flag
    const taskFileIdx = args.indexOf('--task-file');
    if (taskFileIdx !== -1 && args[taskFileIdx + 1]) {
        const taskFilePath = args[taskFileIdx + 1];
        if (!fs.existsSync(taskFilePath)) {
            log('error', `Task file not found: ${taskFilePath}`);
            return null;
        }
        return fs.readFileSync(taskFilePath, 'utf-8').trim();
    }

    // Check for positional argument (skip flags)
    const positionalArgs = args.filter((arg, idx) => {
        if (arg.startsWith('--')) return false;
        // Skip values that follow flags
        if (idx > 0 && args[idx - 1].startsWith('--')) return false;
        return true;
    });

    if (positionalArgs.length > 0) {
        return positionalArgs.join(' ').trim();
    }

    return null;
}

export async function promptForTask(): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log(`\n${colors.cyan}${colors.bold}What would you like to build?${colors.reset}`);
        console.log(`${colors.dim}Enter your task description (press Enter when done):${colors.reset}`);
        rl.question(`${colors.green}> ${colors.reset}`, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// ─── Clarifications Helper ───────────────────────────────────────────────────

export function loadClarifications(): ClarificationEntry[] {
    return loadState<ClarificationEntry[]>('clarifications.json') ?? [];
}

export function saveClarifications(entries: ClarificationEntry[]): void {
    saveState('clarifications.json', entries);
}

export function formatClarificationsForPrompt(entries: ClarificationEntry[]): string {
    if (entries.length === 0) return 'No clarifications have been provided yet.';

    let text = '';
    for (const entry of entries) {
        const sourceLabel = entry.source === 'agent' ? ' (answered by AI agent)' : '';
        text += `\n## Clarification Round ${entry.round}${sourceLabel}\n\n`;
        for (const qa of entry.answers) {
            text += `**Q:** ${qa.question}\n**A:** ${qa.answer}\n\n`;
        }
    }
    return text.trim();
}

// ─── Business Clarifications Helper ──────────────────────────────────────────

export function loadBusinessClarifications(): ClarificationEntry[] {
    return loadState<ClarificationEntry[]>('business-clarifications.json') ?? [];
}

export function saveBusinessClarifications(entries: ClarificationEntry[]): void {
    saveState('business-clarifications.json', entries);
}

export function formatBusinessClarificationsForPrompt(entries: ClarificationEntry[]): string {
    if (entries.length === 0) return 'No business clarifications have been provided yet.';

    let text = '';
    for (const entry of entries) {
        text += `\n## Business Clarification Round ${entry.round}\n\n`;
        for (const qa of entry.answers) {
            text += `**Q:** ${qa.question}\n**A:** ${qa.answer}\n\n`;
        }
    }
    return text.trim();
}

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

export interface CliArgs {
    dryRun: boolean;
    resume: boolean;
    taskFile: string | null;
    task: string | null;
    mode: string | null;
    stopAfterPrd: boolean;
    projectDir: string | null;
}

export function parseArgs(argv: string[]): CliArgs {
    // argv[0] = node, argv[1] = script path, rest = user args
    const args = argv.slice(2);

    const result: CliArgs = {
        dryRun: false,
        resume: false,
        taskFile: null,
        task: null,
        mode: null,
        stopAfterPrd: false,
        projectDir: null,
    };

    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--dry-run') {
            result.dryRun = true;
        } else if (arg === '--resume') {
            result.resume = true;
        } else if (arg === '--task-file') {
            result.taskFile = args[++i] ?? null;
        } else if (arg === '--mode') {
            result.mode = args[++i] ?? null;
        } else if (arg === '--stop-after-prd') {
            result.stopAfterPrd = true;
        } else if (arg === '--project-dir') {
            result.projectDir = args[++i] ?? null;
        } else if (!arg.startsWith('--')) {
            positional.push(arg);
        }
    }

    if (positional.length > 0) {
        result.task = positional.join(' ');
    }

    return result;
}
