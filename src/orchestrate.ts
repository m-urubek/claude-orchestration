#!/usr/bin/env npx tsx

import type {
    PipelineConfig,
    PipelineMode,
    PrdPhaseContext,
    PrdGeneratorOutput,
    PrdAnalysisResult,
    BusinessAnalysisResult,
    ClarificationAnswerResult,
    AgentSessionResult,
    PlanResult,
    Assignment,
    MicroplanResult,
    ImplementerResult,
    VerifierResult,
    FinalVerifierResult,
    AgentInvocation,
    ClarificationEntry,
} from './lib/types.js';

import { runAgent, runAgentWithSession, resumeAgent, getSchemaForAgent } from './lib/runner.js';

import {
    log,
    checkGitClean,
    loadConfig,
    ensureStateDir,
    ensureAssignmentDir,
    saveState,
    loadState,
    saveTextState,
    loadTextState,
    loadPipelineState,
    initPipelineState,
    updatePipelineState,
    promptUser,
    promptForTask,
    promptForProjectDir,
    loadClarifications,
    saveClarifications,
    formatClarificationsForPrompt,
    loadBusinessClarifications,
    saveBusinessClarifications,
    formatBusinessClarificationsForPrompt,
    parseArgs,
    getTaskDescription,
    setProjectDir,
    getProjectDir,
    getOrchestratorRoot,
    wrapPromptWithProjectDir,
} from './lib/utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Mode Registry
// ═══════════════════════════════════════════════════════════════════════════════

const MODE_REGISTRY: Map<string, PipelineMode> = new Map();

function registerMode(mode: PipelineMode): void {
    MODE_REGISTRY.set(mode.name, mode);
}

function getMode(name: string): PipelineMode {
    const mode = MODE_REGISTRY.get(name);
    if (!mode) {
        const available = Array.from(MODE_REGISTRY.keys()).join(', ');
        throw new Error(`Unknown mode: "${name}". Available modes: ${available}`);
    }
    return mode;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Interactive Mode (existing behavior, refactored into PipelineMode)
// ═══════════════════════════════════════════════════════════════════════════════

const interactiveMode: PipelineMode = {
    name: 'interactive',
    description: 'Human answers all clarification questions via stdin',

    async runPrdPhase(ctx: PrdPhaseContext): Promise<void> {
        const maxClarificationRounds = ctx.config.limits.maxClarificationRounds;

        // Resume-aware: start from the number of existing clarification rounds
        const existingClarifications = loadClarifications();
        const startRound = existingClarifications.length;

        if (startRound > 0) {
            log('info', `Found ${startRound} existing clarification round(s) — continuing from there`);
        }

        for (let round = startRound; round <= maxClarificationRounds; round++) {
            // Step 1a: Generate PRD
            updatePipelineState({ phase: 'prd-generation', clarificationRound: round });
            log('phase', `Phase 1a: PRD Generation (round ${round})`);

            const clarifications = loadClarifications();
            const feedback = loadTextState('final-feedback.md');

            const prdPrompt = wrapPromptWithProjectDir(
                buildPrdGeneratorPrompt(ctx.task, clarifications, [], feedback, ctx.config.projectContext)
            );

            const prdInvocation: AgentInvocation = {
                agent: 'prd-generator',
                prompt: prdPrompt,
                jsonSchema: getSchemaForAgent('prd-generator'),
                allowedTools: ['Read', 'Write', 'Grep', 'Glob'],
            };

            await runAgent<PrdGeneratorOutput>(prdInvocation, {
                config: ctx.config,
                stateFile: 'prd-output.json',
                dryRun: ctx.dryRun,
            });

            // Step 1b: Analyze PRD
            updatePipelineState({ phase: 'prd-analysis' });
            log('phase', 'Phase 1b: PRD Analysis');

            const analysis = await runPrdAnalysis(ctx.config, clarifications, ctx.dryRun);

            log('info', `PRD Analysis: confidence=${analysis.confidence}/10, needsClarification=${analysis.needsClarification}`);
            log('info', `Reasoning: ${analysis.reasoning.slice(0, 200)}`);

            // Step 1c: Handle clarification if needed
            if (analysis.needsClarification && analysis.questions.length > 0 && round < maxClarificationRounds) {
                updatePipelineState({ phase: 'clarification' });
                log('phase', `Phase 1c: Clarification (round ${round + 1}/${maxClarificationRounds})`);

                const answers = await promptUser(analysis.questions);

                const entry: ClarificationEntry = {
                    round: round + 1,
                    questions: analysis.questions,
                    answers,
                    source: 'human',
                };
                clarifications.push(entry);
                saveClarifications(clarifications);

                log('success', `Clarification round ${round + 1} saved`);
            } else {
                if (analysis.needsClarification) {
                    log('warn', 'Clarification needed but max rounds reached. Proceeding with current PRD.');
                } else {
                    log('success', 'PRD analysis passed - no further clarification needed');
                }
                break;
            }
        }
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Autonomous Mode
// ═══════════════════════════════════════════════════════════════════════════════

const autonomousMode: PipelineMode = {
    name: 'autonomous',
    description: 'Business questions for human, technical questions answered by agent',

    async runPrdPhase(ctx: PrdPhaseContext): Promise<void> {
        // Phase 1A: Business clarification (human answers brief business Qs)
        log('phase', '═══ Autonomous Mode: Phase 1A — Business Requirements ═══');
        log('info', 'You will be asked brief business-only questions. Technical details are handled by AI.');
        await businessClarificationLoop(ctx);

        // Phase 1B: Technical clarification (agent answers)
        log('phase', '═══ Autonomous Mode: Phase 1B — Technical Clarification (unattended) ═══');
        log('info', 'An AI agent will now answer technical clarification questions. No user input needed.');
        await technicalClarificationLoop(ctx);

        log('success', 'PRD finalized through autonomous mode');
    },
};

// ─── Business Clarification Loop ─────────────────────────────────────────────

async function businessClarificationLoop(ctx: PrdPhaseContext): Promise<void> {
    const maxRounds = ctx.config.limits.maxBusinessClarificationRounds;
    const existingBusinessClarifications = loadBusinessClarifications();
    const startRound = existingBusinessClarifications.length;

    if (startRound > 0) {
        log('info', `Found ${startRound} existing business clarification round(s) — continuing from there`);
    }

    for (let round = startRound; round <= maxRounds; round++) {
        // Generate PRD (using task + business clarifications so far, no tech clarifications yet)
        updatePipelineState({ phase: 'prd-generation', clarificationRound: round });
        log('phase', `Business PRD Generation (round ${round})`);

        const feedback = loadTextState('final-feedback.md');
        const prdPrompt = wrapPromptWithProjectDir(
            buildPrdGeneratorPrompt(
                ctx.task,
                [],                              // no tech clarifications yet
                existingBusinessClarifications,   // business clarifications
                feedback,
                ctx.config.projectContext
            )
        );

        const prdInvocation: AgentInvocation = {
            agent: 'prd-generator',
            prompt: prdPrompt,
            jsonSchema: getSchemaForAgent('prd-generator'),
            allowedTools: ['Read', 'Write', 'Grep', 'Glob'],
        };

        await runAgent<PrdGeneratorOutput>(prdInvocation, {
            config: ctx.config,
            stateFile: 'prd-output.json',
            dryRun: ctx.dryRun,
        });

        // Business analysis
        updatePipelineState({ phase: 'business-clarification' });
        log('phase', `Business Analysis (round ${round})`);

        let analysisPrompt = `Analyze the PRD at state/prd.md for missing or unclear BUSINESS requirements.

Read the task description from state/task.md for context.`;

        if (existingBusinessClarifications.length > 0) {
            analysisPrompt += `\n\nExisting business clarifications (check if these resolve previous gaps):\n${formatBusinessClarificationsForPrompt(existingBusinessClarifications)}`;
        }

        const analysisInvocation: AgentInvocation = {
            agent: 'business-analyzer',
            prompt: wrapPromptWithProjectDir(analysisPrompt),
            jsonSchema: getSchemaForAgent('business-analyzer'),
            tools: ['Read', 'Grep', 'Glob'],
            allowedTools: ['Read', 'Grep', 'Glob'],
        };

        const analysis = await runAgent<BusinessAnalysisResult>(analysisInvocation, {
            config: ctx.config,
            stateFile: 'business-analysis.json',
            dryRun: ctx.dryRun,
        });

        log('info', `Business Analysis: confidence=${analysis.confidence}/10, needsClarification=${analysis.needsClarification}`);

        if (analysis.needsClarification && analysis.questions.length > 0 && round < maxRounds) {
            // Prompt HUMAN via stdin — same as interactive mode
            const answers = await promptUser(analysis.questions);

            existingBusinessClarifications.push({
                round: round + 1,
                questions: analysis.questions,
                answers,
                source: 'human',
            });
            saveBusinessClarifications(existingBusinessClarifications);

            log('success', `Business clarification round ${round + 1} saved`);
        } else {
            if (analysis.needsClarification) {
                log('warn', 'Business clarification needed but max rounds reached. Proceeding.');
            } else {
                log('success', 'Business requirements are clear — moving to technical clarification');
            }
            break;
        }
    }
}

// ─── Technical Clarification Loop (Agent-Answered) ───────────────────────────

async function technicalClarificationLoop(ctx: PrdPhaseContext): Promise<void> {
    const maxRounds = ctx.config.limits.maxClarificationRounds;
    const maxQuestionsPerInstance = ctx.config.limits.maxQuestionsPerAnswererInstance;
    const businessClarifications = loadBusinessClarifications();
    const existingTechClarifications = loadClarifications();
    const startRound = existingTechClarifications.length;

    if (startRound > 0) {
        log('info', `Found ${startRound} existing tech clarification round(s) — continuing from there`);
    }

    for (let round = startRound; round <= maxRounds; round++) {
        // Generate PRD (using task + business clarifications + tech clarifications)
        updatePipelineState({ phase: 'prd-generation', clarificationRound: round });
        log('phase', `Technical PRD Generation (round ${round})`);

        const feedback = loadTextState('final-feedback.md');
        const prdPrompt = wrapPromptWithProjectDir(
            buildPrdGeneratorPrompt(
                ctx.task,
                existingTechClarifications,
                businessClarifications,
                feedback,
                ctx.config.projectContext
            )
        );

        const prdInvocation: AgentInvocation = {
            agent: 'prd-generator',
            prompt: prdPrompt,
            jsonSchema: getSchemaForAgent('prd-generator'),
            allowedTools: ['Read', 'Write', 'Grep', 'Glob'],
        };

        await runAgent<PrdGeneratorOutput>(prdInvocation, {
            config: ctx.config,
            stateFile: 'prd-output.json',
            dryRun: ctx.dryRun,
        });

        // Standard PRD analysis
        updatePipelineState({ phase: 'prd-analysis' });
        log('phase', `Technical PRD Analysis (round ${round})`);

        const allClarifications = [...existingTechClarifications];
        const analysis = await runPrdAnalysis(ctx.config, allClarifications, ctx.dryRun);

        log('info', `PRD Analysis: confidence=${analysis.confidence}/10, needsClarification=${analysis.needsClarification}`);
        log('info', `Reasoning: ${analysis.reasoning.slice(0, 200)}`);

        if (analysis.needsClarification && analysis.questions.length > 0 && round < maxRounds) {
            updatePipelineState({ phase: 'agent-clarification' });
            log('phase', `Agent Clarification (round ${round + 1}/${maxRounds})`);

            // Answer questions one at a time, reusing agent sessions in batches
            const answers: Array<{ question: string; answer: string }> = [];
            let sessionId: string | null = null;
            let questionsInSession = 0;

            for (let qi = 0; qi < analysis.questions.length; qi++) {
                const q = analysis.questions[qi];

                // Start a new agent instance every N questions
                if (questionsInSession >= maxQuestionsPerInstance) {
                    sessionId = null;
                    questionsInSession = 0;
                }

                let result: ClarificationAnswerResult;

                if (sessionId) {
                    // Resume existing session — context is already loaded
                    const prompt = wrapPromptWithProjectDir(buildFollowUpQuestionPrompt(q));
                    const response: AgentSessionResult<ClarificationAnswerResult> = await resumeAgent<ClarificationAnswerResult>(
                        sessionId,
                        prompt,
                        getSchemaForAgent('clarification-answerer'),
                        { config: ctx.config, dryRun: ctx.dryRun }
                    );
                    result = response.result;
                    sessionId = response.sessionId;
                } else {
                    // Fresh invocation — agent will load PRD, task, explore codebase
                    const prompt = wrapPromptWithProjectDir(buildFirstQuestionPrompt(q, businessClarifications));
                    const invocation: AgentInvocation = {
                        agent: 'clarification-answerer',
                        prompt,
                        jsonSchema: getSchemaForAgent('clarification-answerer'),
                        tools: ['Read', 'Grep', 'Glob', 'Bash'],
                        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
                    };
                    const response = await runAgentWithSession<ClarificationAnswerResult>(invocation, {
                        config: ctx.config,
                        dryRun: ctx.dryRun,
                    });
                    result = response.result;
                    sessionId = response.sessionId;
                }

                questionsInSession++;

                answers.push({
                    question: q.question,
                    answer: result.confident
                        ? result.answer
                        : `[Agent uncertain] ${result.answer}`,
                });

                log('info', `  Answered Q${qi + 1}/${analysis.questions.length}: ${result.confident ? 'confident' : 'uncertain'}`);

                if (!result.confident) {
                    log('warn', `  Low confidence: ${q.question.slice(0, 80)}...`);
                }
            }

            // Save all answers as a clarification round
            existingTechClarifications.push({
                round: round + 1,
                questions: analysis.questions,
                answers,
                source: 'agent',
            });
            saveClarifications(existingTechClarifications);

            log('success', `Agent clarification round ${round + 1} saved (${answers.length} answers)`);
        } else {
            if (analysis.needsClarification) {
                log('warn', 'Clarification needed but max rounds reached. Proceeding with current PRD.');
            } else {
                log('success', 'PRD analysis passed - no further clarification needed');
            }
            break;
        }
    }
}

// ─── Clarification Answerer Prompt Builders ──────────────────────────────────

function buildFirstQuestionPrompt(
    question: { question: string; reason: string },
    businessClarifications: ClarificationEntry[]
): string {
    let prompt = `Read the PRD at state/prd.md.
Read the task description at state/task.md.`;

    if (businessClarifications.length > 0) {
        prompt += `\nRead the business clarifications at state/business-clarifications.json.`;
    }

    prompt += `

You will be answering technical clarification questions about this project ONE AT A TIME.
Each follow-up question will arrive via --resume. Keep your codebase exploration in mind
for future questions.

Answer this question:
Question: ${question.question}
Reason it was asked: ${question.reason}`;

    return prompt;
}

function buildFollowUpQuestionPrompt(
    question: { question: string; reason: string }
): string {
    return `Answer this next question using your existing knowledge of the codebase
(explore further if needed):

Question: ${question.question}
Reason it was asked: ${question.reason}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function buildPrdGeneratorPrompt(
    task: string,
    techClarifications: ClarificationEntry[],
    businessClarifications: ClarificationEntry[],
    feedback: string | null,
    projectContext: string
): string {
    let prdPrompt = `You have a task to create a Product Requirements Document (PRD).

Read the task description from: state/task.md

The task is:
${task}
`;

    if (businessClarifications.length > 0) {
        prdPrompt += `\nThe following BUSINESS clarifications have been provided by the stakeholder:
${formatBusinessClarificationsForPrompt(businessClarifications)}\n`;
    }

    if (techClarifications.length > 0) {
        prdPrompt += `\nThe following technical clarifications have been collected.

IMPORTANT: These clarifications were collected over multiple rounds and may reference requirement IDs (e.g., R1.1, R7.4), section numbers, or specific wording from EARLIER versions of the PRD that no longer exist or have been renumbered. Do NOT blindly copy old requirement IDs. Instead:
- Understand the INTENT behind each clarification answer
- Incorporate the substance of the answer into the new PRD using your own structure and numbering
- If a clarification references something you cannot identify, infer the intent from the question context

Clarifications:
${formatClarificationsForPrompt(techClarifications)}\n`;
    }

    if (feedback) {
        prdPrompt += `\nThe following feedback was received from a previous verification round. Incorporate it into the PRD:\n${feedback}\n`;
    }

    prdPrompt += `\nWrite the PRD to: state/prd.md`;

    if (projectContext) {
        prdPrompt += `\n\nAdditional project context:\n${projectContext}`;
    }

    return prdPrompt;
}

async function runPrdAnalysis(
    config: PipelineConfig,
    clarifications: ClarificationEntry[],
    dryRun: boolean
): Promise<PrdAnalysisResult> {
    let analysisPrompt = `Analyze the PRD at state/prd.md for completeness, clarity, and gaps.

Read the task description from state/task.md for context.`;

    if (clarifications.length > 0) {
        analysisPrompt += `\n\nExisting clarifications (check if these resolve previous gaps):\n${formatClarificationsForPrompt(clarifications)}`;
    }

    const analysisInvocation: AgentInvocation = {
        agent: 'prd-analyzer',
        prompt: wrapPromptWithProjectDir(analysisPrompt),
        jsonSchema: getSchemaForAgent('prd-analyzer'),
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
    };

    return await runAgent<PrdAnalysisResult>(analysisInvocation, {
        config,
        stateFile: 'analysis.json',
        dryRun,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Register Modes
// ═══════════════════════════════════════════════════════════════════════════════

registerMode(interactiveMode);
registerMode(autonomousMode);

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    console.log('\n\x1b[36m\x1b[1m╔══════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[36m\x1b[1m║   Claude Code Agent Pipeline Orchestrator ║\x1b[0m');
    console.log('\x1b[36m\x1b[1m║               v2 — Dynamic Modes          ║\x1b[0m');
    console.log('\x1b[36m\x1b[1m╚══════════════════════════════════════════╝\x1b[0m\n');

    const cliArgs = parseArgs(process.argv);

    // Load config (always from orchestrator root, resolved via import.meta.url)
    const config = loadConfig();
    log('info', `Pipeline config loaded from ${getOrchestratorRoot()}`);

    // Ensure state directory exists
    ensureStateDir();

    // Handle --resume (project dir restored from saved state)
    if (cliArgs.resume) {
        const existingState = loadPipelineState();
        if (!existingState) {
            log('error', 'No pipeline state found to resume from');
            process.exit(1);
            return;
        }

        // Restore project dir from saved state
        if (existingState.projectDir) {
            setProjectDir(existingState.projectDir);
            log('info', `Project directory (from state): ${existingState.projectDir}`);
        } else {
            log('error', 'Saved state is missing projectDir. Cannot resume.');
            process.exit(1);
            return;
        }

        log('info', `Resuming pipeline from phase: ${existingState.phase}`);

        // On resume, use the mode from saved state (not from CLI)
        const resumeMode = getMode(existingState.mode ?? 'interactive');
        log('info', `Resume mode: ${resumeMode.name}`);

        await resumePipeline(config, existingState.phase, cliArgs.dryRun, resumeMode, existingState.stopAfterPrd ?? false);
        return;
    }

    // Resolve project directory: --project-dir flag → interactive prompt
    let projectDir = cliArgs.projectDir;
    if (!projectDir) {
        projectDir = await promptForProjectDir();
    }
    setProjectDir(projectDir);
    log('info', `Project directory: ${getProjectDir()}`);

    // Resolve mode
    const modeName = cliArgs.mode ?? config.defaultMode ?? 'interactive';
    const mode = getMode(modeName);
    log('info', `Pipeline mode: ${mode.name} — ${mode.description}`);

    // Check git status (in the project directory)
    checkGitClean();

    // Get task description
    let task: string | null = null;

    if (cliArgs.taskFile) {
        const taskFileArgs = ['--task-file', cliArgs.taskFile];
        task = getTaskDescription(taskFileArgs);
    } else if (cliArgs.task) {
        task = cliArgs.task;
    }

    if (!task) {
        task = await promptForTask();
    }

    if (!task || task.trim().length === 0) {
        log('error', 'No task description provided');
        process.exit(1);
    }

    log('info', `Task: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`);

    // Save task and initialize state (state lives in orchestrator root)
    saveTextState('task.md', task);
    const pipelineState = initPipelineState(modeName, cliArgs.stopAfterPrd);
    log('info', `Pipeline started at ${pipelineState.startedAt}`);

    // Run the pipeline
    await runPipeline(config, task, cliArgs.dryRun, mode, cliArgs.stopAfterPrd);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pipeline Flow
// ═══════════════════════════════════════════════════════════════════════════════

async function runPipeline(
    config: PipelineConfig,
    task: string,
    dryRun: boolean,
    mode: PipelineMode,
    stopAfterPrd: boolean
): Promise<void> {
    const maxRetries = config.limits.maxPipelineRetries;

    for (let iteration = 0; iteration <= maxRetries; iteration++) {
        updatePipelineState({ pipelineIteration: iteration });

        if (iteration > 0) {
            log('phase', `Pipeline retry iteration ${iteration}/${maxRetries}`);
        }

        // Phase 1: PRD — delegated to the mode
        await mode.runPrdPhase({ config, task, dryRun, stopAfterPrd });

        // Check --stop-after-prd
        if (stopAfterPrd) {
            updatePipelineState({ phase: 'prd-review-stop' });
            log('success', '═══ PRD finalized — stopped for review ═══');
            log('info', 'Review the PRD at: state/prd.md');
            log('info', 'When ready, run with --resume to continue from planning phase.');
            return;
        }

        // Phase 2: Planning
        await planningPhase(config, dryRun);

        // Phase 3: Implementation (sequential assignments)
        await implementationPhase(config, dryRun);

        // Phase 4: Final Verification
        const finalResult = await finalVerification(config, dryRun);

        if (finalResult.passed) {
            log('success', '═══ Pipeline completed successfully! ═══');
            console.log(`\n\x1b[32m\x1b[1mSuggested commit message:\x1b[0m`);
            console.log(`  ${finalResult.commitMessage}\n`);
            return;
        }

        if (iteration < maxRetries) {
            log('warn', `Final verification failed. Feedback: ${finalResult.feedback}`);
            log('info', 'Unmet requirements:');
            for (const req of finalResult.unmetRequirements) {
                console.log(`  - ${req}`);
            }
            // Save feedback for next iteration
            saveTextState('final-feedback.md', finalResult.feedback);
        } else {
            log('error', '═══ Pipeline exhausted all retries ═══');
            log('error', `Final feedback: ${finalResult.feedback}`);
            process.exit(1);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Resume Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

async function resumePipeline(
    config: PipelineConfig,
    fromPhase: string,
    dryRun: boolean,
    mode: PipelineMode,
    stopAfterPrd: boolean
): Promise<void> {
    const task = loadTextState('task.md');
    if (!task) {
        log('error', 'No task description found in state. Cannot resume.');
        process.exit(1);
        return;
    }

    switch (fromPhase) {
        case 'init':
        case 'prd-generation':
        case 'prd-analysis':
        case 'clarification':
            // Resume from PRD phase: continue generation loop with existing clarifications
            await mode.runPrdPhase({ config, task, dryRun, stopAfterPrd });
            if (stopAfterPrd) {
                updatePipelineState({ phase: 'prd-review-stop' });
                log('success', '═══ PRD finalized — stopped for review ═══');
                log('info', 'Review the PRD at: state/prd.md');
                log('info', 'When ready, run with --resume to continue from planning phase.');
                return;
            }
            await planningPhase(config, dryRun);
            await implementationPhase(config, dryRun);
            await handleFinalAndMaybeRetry(config, task, dryRun);
            break;

        case 'business-clarification':
        case 'agent-clarification':
            // Resume autonomous mode from where it left off
            await mode.runPrdPhase({ config, task, dryRun, stopAfterPrd });
            if (stopAfterPrd) {
                updatePipelineState({ phase: 'prd-review-stop' });
                log('success', '═══ PRD finalized — stopped for review ═══');
                log('info', 'Review the PRD at: state/prd.md');
                log('info', 'When ready, run with --resume to continue from planning phase.');
                return;
            }
            await planningPhase(config, dryRun);
            await implementationPhase(config, dryRun);
            await handleFinalAndMaybeRetry(config, task, dryRun);
            break;

        case 'prd-review-stop':
            // User reviewed the PRD and is resuming — skip straight to planning
            log('info', 'Resuming from PRD review checkpoint');
            await planningPhase(config, dryRun);
            await implementationPhase(config, dryRun);
            await handleFinalAndMaybeRetry(config, task, dryRun);
            break;

        case 'planning':
            await planningPhase(config, dryRun);
            await implementationPhase(config, dryRun);
            await handleFinalAndMaybeRetry(config, task, dryRun);
            break;

        case 'implementation':
            await implementationPhase(config, dryRun);
            await handleFinalAndMaybeRetry(config, task, dryRun);
            break;

        case 'final-verification':
            await handleFinalAndMaybeRetry(config, task, dryRun);
            break;

        case 'complete':
            log('success', 'Pipeline already completed.');
            break;

        default:
            log('error', `Unknown phase: ${fromPhase}`);
            process.exit(1);
    }
}

async function handleFinalAndMaybeRetry(config: PipelineConfig, task: string, dryRun: boolean): Promise<void> {
    const finalResult = await finalVerification(config, dryRun);
    if (finalResult.passed) {
        log('success', '═══ Pipeline completed successfully! ═══');
        console.log(`\n\x1b[32m\x1b[1mSuggested commit message:\x1b[0m`);
        console.log(`  ${finalResult.commitMessage}\n`);
    } else {
        log('warn', 'Final verification failed on resume. Run pipeline again to retry.');
        saveTextState('final-feedback.md', finalResult.feedback);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2: Planning
// ═══════════════════════════════════════════════════════════════════════════════

async function planningPhase(config: PipelineConfig, dryRun: boolean): Promise<PlanResult> {
    updatePipelineState({ phase: 'planning' });
    log('phase', 'Phase 2: Planning');

    const buildCommandsStr = config.buildCommands.length > 0
        ? `\nBuild commands for this project: ${config.buildCommands.join(', ')}`
        : '';

    const planPrompt = wrapPromptWithProjectDir(`Read the PRD at state/prd.md.
Explore the codebase structure to understand the project.
${buildCommandsStr}

Divide the work into sequential assignments. Each assignment should be roughly one commit's worth of work.
Ensure assignments don't have circular dependencies.
Order them so later assignments can build on earlier ones.
Each assignment should be self-contained enough that an independent agent can implement it with only the PRD and assignment description as context.`);

    const planInvocation: AgentInvocation = {
        agent: 'planner',
        prompt: planPrompt,
        jsonSchema: getSchemaForAgent('planner'),
        tools: ['Read', 'Grep', 'Glob'],
        allowedTools: ['Read', 'Grep', 'Glob'],
    };

    const plan = await runAgent<PlanResult>(planInvocation, {
        config,
        stateFile: 'plan.json',
        dryRun,
    });

    log('success', `Plan created with ${plan.assignments.length} assignments:`);
    for (const a of plan.assignments) {
        log('info', `  [${a.id}] ${a.title} (depends on: ${a.dependsOn.join(', ') || 'none'})`);
    }

    return plan;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3: Implementation
// ═══════════════════════════════════════════════════════════════════════════════

async function implementationPhase(config: PipelineConfig, dryRun: boolean): Promise<void> {
    updatePipelineState({ phase: 'implementation' });

    const plan = loadState<PlanResult>('plan.json');
    if (!plan) {
        log('error', 'No plan found in state. Run planning phase first.');
        process.exit(1);
        return;
    }

    const pipelineState = loadPipelineState();
    if (!pipelineState) {
        log('error', 'No pipeline state found.');
        process.exit(1);
        return;
    }
    const completedAssignments = new Set(pipelineState.completedAssignments);

    for (const assignment of plan.assignments) {
        if (completedAssignments.has(assignment.id)) {
            log('info', `Skipping completed assignment: [${assignment.id}] ${assignment.title}`);
            continue;
        }

        log('phase', `Assignment: [${assignment.id}] ${assignment.title}`);
        updatePipelineState({ currentAssignmentId: assignment.id });
        ensureAssignmentDir(assignment.id);

        await assignmentLoop(config, assignment, dryRun);

        // Mark assignment complete
        completedAssignments.add(assignment.id);
        updatePipelineState({
            completedAssignments: Array.from(completedAssignments),
            currentAssignmentId: null,
        });
        log('success', `Assignment [${assignment.id}] completed`);
    }

    log('success', 'All assignments completed');
}

// ─── Assignment Loop (Microplan → Implement → Verify) ────────────────────────

async function assignmentLoop(
    config: PipelineConfig,
    assignment: Assignment,
    dryRun: boolean
): Promise<void> {
    const maxIterations = config.limits.maxImplementationIterations;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (iteration > 0) {
            log('warn', `Assignment [${assignment.id}] retry ${iteration}/${maxIterations}`);
        }

        // 4a: Microplanner
        log('phase', `  Step 4a: Microplanning for [${assignment.id}]`);

        let microplanPrompt = `Read the PRD at state/prd.md.

You are planning the implementation for assignment "${assignment.id}":
Title: ${assignment.title}
Description: ${assignment.description}
Estimated files: ${assignment.estimatedFiles.join(', ')}
Dependencies: ${assignment.dependsOn.join(', ') || 'none'}

Read the relevant source files in the project directory and produce a concrete step-by-step coding plan.`;

        if (iteration > 0) {
            const prevVerification = loadState<VerifierResult>(
                `assignments/${assignment.id}/verification.json`
            );
            if (prevVerification && !prevVerification.passed) {
                microplanPrompt += `\n\nPREVIOUS VERIFICATION FAILED. Issues to address:\n`;
                for (const issue of prevVerification.issues) {
                    microplanPrompt += `- [${issue.severity}] ${issue.file}: ${issue.description}\n`;
                }
                if (prevVerification.buildOutput) {
                    microplanPrompt += `\nBuild output:\n${prevVerification.buildOutput.slice(0, 2000)}\n`;
                }
            }
        }

        const microplanInvocation: AgentInvocation = {
            agent: 'microplanner',
            prompt: wrapPromptWithProjectDir(microplanPrompt),
            jsonSchema: getSchemaForAgent('microplanner'),
            tools: ['Read', 'Grep', 'Glob'],
            allowedTools: ['Read', 'Grep', 'Glob'],
        };

        const microplan = await runAgent<MicroplanResult>(microplanInvocation, {
            config,
            stateFile: `assignments/${assignment.id}/microplan.json`,
            dryRun,
        });

        log('info', `  Microplan: ${microplan.steps.length} steps, ${microplan.considerations.length} considerations`);

        // 4b: Implementer
        log('phase', `  Step 4b: Implementation for [${assignment.id}]`);

        const buildCommandsStr = config.buildCommands.length > 0
            ? `\nBuild commands available: ${config.buildCommands.join(', ')}`
            : '';

        const implementPrompt = wrapPromptWithProjectDir(`Read the PRD at state/prd.md.
Read the microplan at state/assignments/${assignment.id}/microplan.json.

You are implementing assignment "${assignment.id}":
Title: ${assignment.title}
Description: ${assignment.description}
${buildCommandsStr}

Follow the microplan step by step. Write clean, well-documented code.
Do NOT modify files outside this assignment's scope.
All code changes MUST be made in the project directory (see PROJECT DIRECTORY above).`);

        const implementInvocation: AgentInvocation = {
            agent: 'implementer',
            prompt: implementPrompt,
            jsonSchema: getSchemaForAgent('implementer'),
            allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
        };

        const implResult = await runAgent<ImplementerResult>(implementInvocation, {
            config,
            stateFile: `assignments/${assignment.id}/changes.json`,
            dryRun,
        });

        log('info', `  Implementation: ${implResult.filesModified.length} modified, ${implResult.filesCreated.length} created, ${implResult.filesDeleted.length} deleted`);
        if (implResult.deviations.length > 0) {
            log('warn', `  Deviations from microplan:`);
            for (const d of implResult.deviations) {
                console.log(`    - ${d}`);
            }
        }

        // 4c: Verifier
        log('phase', `  Step 4c: Verification for [${assignment.id}]`);

        const changedFiles = [
            ...implResult.filesModified,
            ...implResult.filesCreated,
        ];

        let verifyPrompt = `You are verifying assignment "${assignment.id}":
Title: ${assignment.title}
Description: ${assignment.description}

Read the PRD at state/prd.md.
Read the implementation changes record at state/assignments/${assignment.id}/changes.json.

Changed files to review: ${changedFiles.join(', ')}

Compare the implementation against the assignment requirements.`;

        if (config.buildCommands.length > 0) {
            verifyPrompt += `\n\nRun these build commands to verify:\n${config.buildCommands.map((cmd) => `- ${cmd}`).join('\n')}`;
        }

        const verifyInvocation: AgentInvocation = {
            agent: 'verifier',
            prompt: wrapPromptWithProjectDir(verifyPrompt),
            jsonSchema: getSchemaForAgent('verifier'),
            tools: ['Read', 'Grep', 'Glob', 'Bash'],
            allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
        };

        const verification = await runAgent<VerifierResult>(verifyInvocation, {
            config,
            stateFile: `assignments/${assignment.id}/verification.json`,
            dryRun,
        });

        const errors = verification.issues.filter((i) => i.severity === 'error');
        const warnings = verification.issues.filter((i) => i.severity === 'warning');
        log('info', `  Verification: passed=${verification.passed}, errors=${errors.length}, warnings=${warnings.length}, buildPassed=${verification.buildPassed}`);

        if (verification.passed) {
            log('success', `  Assignment [${assignment.id}] verified successfully`);
            return;
        }

        log('warn', `  Verification failed for [${assignment.id}]. Issues:`);
        for (const issue of verification.issues) {
            console.log(`    [${issue.severity}] ${issue.file}: ${issue.description}`);
        }

        if (iteration === maxIterations - 1) {
            log('error', `  Assignment [${assignment.id}] failed after ${maxIterations} attempts`);
            throw new Error(`Assignment ${assignment.id} failed verification after max iterations`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4: Final Verification
// ═══════════════════════════════════════════════════════════════════════════════

async function finalVerification(
    config: PipelineConfig,
    dryRun: boolean
): Promise<FinalVerifierResult> {
    updatePipelineState({ phase: 'final-verification' });
    log('phase', 'Phase 4: Final Verification');

    let finalPrompt = `Read the PRD at state/prd.md.
Run \`git diff\` in the project directory to see all changes made during this pipeline run.
Verify that each requirement in the PRD is addressed by the implementation.`;

    if (config.buildCommands.length > 0) {
        finalPrompt += `\n\nRun these build commands:\n${config.buildCommands.map((cmd) => `- ${cmd}`).join('\n')}`;
    }

    finalPrompt += `\n\nIf all requirements are met and builds pass, set passed=true and suggest a conventional commit message.
If not, set passed=false, provide specific feedback and list unmet requirements.`;

    const finalInvocation: AgentInvocation = {
        agent: 'final-verifier',
        prompt: wrapPromptWithProjectDir(finalPrompt),
        jsonSchema: getSchemaForAgent('final-verifier'),
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    };

    const result = await runAgent<FinalVerifierResult>(finalInvocation, {
        config,
        stateFile: 'final-verification.json',
        dryRun,
    });

    if (result.passed) {
        updatePipelineState({ phase: 'complete' });
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

main().catch((err) => {
    log('error', `Pipeline crashed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
        console.error(err.stack);
    }
    process.exit(1);
});
