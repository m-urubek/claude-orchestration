// ─── Agent Structured Output Schemas ─────────────────────────────────────────

export interface PrdGeneratorOutput {
    success: boolean;
    sections: string[];
}

export interface PrdAnalysisResult {
    needsClarification: boolean;
    questions: Array<{ question: string; reason: string }>;
    confidence: number;
    reasoning: string;
}

export interface BusinessAnalysisResult {
    needsClarification: boolean;
    questions: Array<{ question: string; reason: string }>;
    confidence: number;
    reasoning: string;
}

export interface ClarificationAnswerResult {
    question: string;
    answer: string;
    confident: boolean;
    evidence: string;
}

export interface PlanResult {
    assignments: Assignment[];
}

export interface Assignment {
    id: string;
    title: string;
    description: string;
    dependsOn: string[];
    estimatedFiles: string[];
}

export interface MicroplanResult {
    steps: Array<{
        description: string;
        file: string;
        action: 'modify' | 'create' | 'delete';
    }>;
    considerations: string[];
    filesToRead: string[];
}

export interface ImplementerResult {
    filesModified: string[];
    filesCreated: string[];
    filesDeleted: string[];
    summary: string;
    deviations: string[];
}

export interface VerifierResult {
    passed: boolean;
    issues: Array<{
        severity: 'error' | 'warning';
        file: string;
        description: string;
    }>;
    buildPassed: boolean;
    buildOutput: string;
}

export interface FinalVerifierResult {
    passed: boolean;
    commitMessage: string;
    feedback: string;
    unmetRequirements: string[];
}

// ─── Pipeline Configuration ──────────────────────────────────────────────────

export interface AgentConfig {
    model: string;
    maxTurns: number;
    maxBudgetUsd?: number;
}

export interface PipelineConfig {
    agents: {
        'prd-generator': AgentConfig;
        'prd-analyzer': AgentConfig;
        'business-analyzer': AgentConfig;
        'clarification-answerer': AgentConfig;
        planner: AgentConfig;
        microplanner: AgentConfig;
        implementer: AgentConfig;
        verifier: AgentConfig;
        'final-verifier': AgentConfig;
    };
    limits: {
        maxBusinessClarificationRounds: number;
        maxClarificationRounds: number;
        maxQuestionsPerAnswererInstance: number;
        maxImplementationIterations: number;
        maxPipelineRetries: number;
        agentTimeoutMinutes?: number;
    };
    defaultMode: string;
    buildCommands: string[];
    projectContext: string;
}

// ─── Pipeline State ──────────────────────────────────────────────────────────

export type PipelinePhase =
    | 'init'
    | 'business-clarification'
    | 'prd-generation'
    | 'prd-analysis'
    | 'clarification'
    | 'agent-clarification'
    | 'prd-review-stop'
    | 'planning'
    | 'implementation'
    | 'final-verification'
    | 'complete';

export interface PipelineState {
    phase: PipelinePhase;
    mode: string;
    projectDir: string;
    stopAfterPrd: boolean;
    completedAssignments: string[];
    currentAssignmentId: string | null;
    clarificationRound: number;
    pipelineIteration: number;
    startedAt: string;
    updatedAt: string;
}

// ─── Pipeline Modes ──────────────────────────────────────────────────────────

export interface PrdPhaseContext {
    config: PipelineConfig;
    task: string;
    dryRun: boolean;
    stopAfterPrd: boolean;
}

export interface PipelineMode {
    name: string;
    description: string;
    runPrdPhase(ctx: PrdPhaseContext): Promise<void>;
}

// ─── Agent Invocation ────────────────────────────────────────────────────────

export type AgentName =
    | 'prd-generator'
    | 'prd-analyzer'
    | 'business-analyzer'
    | 'clarification-answerer'
    | 'planner'
    | 'microplanner'
    | 'implementer'
    | 'verifier'
    | 'final-verifier';

export interface AgentInvocation {
    agent: AgentName;
    prompt: string;
    jsonSchema: Record<string, unknown>;
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    tools?: string[];
    allowedTools?: string[];
}

// ─── Agent Session (for clarification-answerer reuse) ────────────────────────

export interface AgentSessionResult<T> {
    result: T;
    sessionId: string;
}

// ─── Claude CLI JSON Response ────────────────────────────────────────────────

export interface ClaudeJsonResponse {
    session_id: string;
    result: string;
    is_error: boolean;
    duration_ms: number;
    duration_api_ms: number;
    num_turns: number;
    cost_usd?: number;
    // structured_output is present when --json-schema is used
    // It will be the parsed object matching the provided schema
    [key: string]: unknown;
}

// ─── Clarification ───────────────────────────────────────────────────────────

export interface ClarificationEntry {
    round: number;
    questions: Array<{ question: string; reason: string }>;
    answers: Array<{ question: string; answer: string }>;
    source?: 'human' | 'agent';
}

// ─── Logging Types ───────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'phase' | 'debug';

export type LogEvent =
    | {
          type: 'system';
          level: LogLevel;
          message: string;
          timestamp: string;
      }
    | {
          type: 'agent';
          agent: string;
          invocationId: string;
          message: string;
          timestamp: string;
      };
