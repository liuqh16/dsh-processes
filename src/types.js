/**
 * Shared vocabulary for the dsh-processes plugin: public process facts, tool
 * argument and result types, notification settings, resolved configuration,
 * and the durable `process/*` session events appended to the owning agent's
 * session.
 * @module dsh-processes/types
 */
/** Statuses a managed process can hold; the first three are live. */
export const PROCESS_STATUSES = [
    'running',
    'terminating',
    'finished',
    'failed',
    'killed',
    'terminate_timeout',
];
/** Live statuses: work still owed to the process tree. */
export const LIVE_STATUSES = new Set(['running', 'terminating']);
/** Output streams the `output` action and log matchers can select. */
export const PROCESS_STREAMS = ['stdout', 'stderr', 'both'];
/** Pattern matching modes for output filters and log matchers. */
export const PROCESS_MATCH_MODES = ['literal', 'regex'];
/** Agent attention levels for one notification. */
export const NOTIFY_ATTENTIONS = ['turn', 'context', 'ignore'];
/** How an `update` call changes a process's log matchers. */
export const WATCH_UPDATE_MODES = ['append', 'replace', 'remove', 'clear'];
/** Sort orders accepted by the `list` action. */
export const PROCESS_SORTS = [
    'startTime_desc',
    'startTime_asc',
    'name_asc',
    'name_desc',
    'status_asc',
];
/** Bounds shared by the tool schema and runtime validation. */
export const LIMITS = {
    /** Hard cap on one log-match pattern length (chars). */
    patternLength: 500,
    /** Hard cap on log matchers per process. */
    maxMatchers: 20,
    /** Default tail lines for the `output` action. */
    defaultTailLines: 100,
    /** Upper bound on `output` tail lines. */
    maxTailLines: 2000,
    /** Upper bound on `list` results. */
    maxListLimit: 200,
};
//# sourceMappingURL=types.js.map