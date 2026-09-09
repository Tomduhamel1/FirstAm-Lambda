const axios = require('axios');

/**
 * FirstAm's LVIS RateCalc backend intermittently returns HTTP 500 for the same
 * request payload (observed ~20-25% failure rate on some low-value purchase
 * profiles; identical inputs both succeed and fail across repeated calls).
 * These are transient upstream faults, not payload problems, so a bounded retry
 * with backoff recovers cleanly and returns correct rates instead of surfacing
 * a 500 to the caller.
 *
 * It also sometimes stops answering altogether (2026-09-09: ProductList took
 * 25-60s+ per call). Without an HTTP timeout a single hung socket burns the whole
 * Lambda budget, API Gateway 504s at 29s with a generic body, and the Lambda keeps
 * running for nothing. So every call now runs under a per-request time budget:
 *   - beginRequestBudget(context) is called once at Lambda entry (index.js)
 *   - each attempt gets timeout = min(perCallCap, remainingBudget - safetyMargin)
 *   - when no budget is left, the request is not sent at all
 *   - a timeout that cannot be retried within budget throws UpstreamTimeoutError,
 *     which handlers turn into a 503 JSON body via upstreamTimeoutResponse()
 *
 * Retries on: HTTP 5xx responses and network-level errors (no response), and at
 * most once on a timeout when a full-size retry still fits in the budget.
 * Does NOT retry on 4xx (those are genuine request problems that won't self-heal).
 *
 * All limits are overridable via environment variables (values in ms):
 *   FIRSTAM_REQUEST_BUDGET_MS      whole-request budget (default 26000; API Gateway hard limit is 29000)
 *   FIRSTAM_SAFETY_MARGIN_MS       reserved for parsing/DynamoDB/response build after the last call (1500)
 *   FIRSTAM_MIN_CALL_MS            below this, don't send a request at all (2000)
 *   FIRSTAM_OAUTH_TIMEOUT_MS       per-call cap for the Azure AD token call (5000)
 *   FIRSTAM_TXTYPES_TIMEOUT_MS     per-call cap for TransactionTypes (6000)
 *   FIRSTAM_PRODUCTLIST_TIMEOUT_MS per-call cap for ProductList (12000)
 *   FIRSTAM_RATECALC_TIMEOUT_MS    per-call cap for RateCalc L1/L2 (20000)
 */

function envMs(name, fallback) {
    const value = parseInt(process.env[name], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const REQUEST_BUDGET_MS = envMs('FIRSTAM_REQUEST_BUDGET_MS', 26000);
const SAFETY_MARGIN_MS = envMs('FIRSTAM_SAFETY_MARGIN_MS', 1500);
const MIN_CALL_MS = envMs('FIRSTAM_MIN_CALL_MS', 2000);
const PER_CALL_CAPS_MS = {
    OAUTH: envMs('FIRSTAM_OAUTH_TIMEOUT_MS', 5000),
    TXTYPES: envMs('FIRSTAM_TXTYPES_TIMEOUT_MS', 6000),
    PRODUCTLIST: envMs('FIRSTAM_PRODUCTLIST_TIMEOUT_MS', 12000),
    RATECALC: envMs('FIRSTAM_RATECALC_TIMEOUT_MS', 20000),
};
const RETRY_AFTER_SECONDS = 120;
const USER_FACING_MESSAGE =
    'The FirstAm rate calculator is not responding. Please try again in a few minutes.';

// axios error codes that mean "we gave up waiting", as opposed to an upstream answer.
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED']);

// ---- Per-request time budget (module scope is safe: one invocation at a time per container)

let deadlineAt = null;
let currentRequestId = null;

/**
 * Start the time budget for this invocation. Call once at Lambda entry.
 * @param {Object} [context] - Lambda context (uses getRemainingTimeInMillis / awsRequestId when present)
 */
function beginRequestBudget(context) {
    let budget = REQUEST_BUDGET_MS;
    if (context && typeof context.getRemainingTimeInMillis === 'function') {
        budget = Math.min(budget, context.getRemainingTimeInMillis() - 2000);
    }
    deadlineAt = Date.now() + Math.max(budget, MIN_CALL_MS);
    currentRequestId = (context && context.awsRequestId) || null;
}

function remainingBudgetMs() {
    if (deadlineAt === null) {
        beginRequestBudget(null);
    }
    return deadlineAt - Date.now();
}

// ---- Error type + response builder

class UpstreamTimeoutError extends Error {
    constructor({ upstream, timeoutMs, elapsedMs, exhausted, cause }) {
        super(
            exhausted
                ? `${upstream} not attempted: no request time budget left`
                : `${upstream} did not respond within ${timeoutMs}ms`
        );
        this.name = 'UpstreamTimeoutError';
        this.code = 'UPSTREAM_TIMEOUT';
        this.upstream = upstream;
        this.timeoutMs = timeoutMs;
        this.elapsedMs = elapsedMs;
        this.exhausted = Boolean(exhausted);
        if (cause) this.cause = cause;
    }
}

/**
 * Build the API Gateway response for an UpstreamTimeoutError, or return null for any other error.
 * 503 (not 504) so callers can distinguish "we detected the hang" from "API Gateway killed us";
 * `message` is the text client apps display to users.
 */
function upstreamTimeoutResponse(error, headers = {}) {
    if (!error || error.code !== 'UPSTREAM_TIMEOUT') {
        return null;
    }
    return {
        statusCode: 503,
        headers: { ...headers, 'Retry-After': String(RETRY_AFTER_SECONDS) },
        body: JSON.stringify({
            error: 'UPSTREAM_TIMEOUT',
            message: USER_FACING_MESSAGE,
            upstream: error.upstream,
            requestId: currentRequestId,
            elapsedMs: error.elapsedMs,
            exhausted: error.exhausted,
            retryAfterSeconds: RETRY_AFTER_SECONDS,
        }),
    };
}

function capForLabel(label = '') {
    const l = label.toLowerCase();
    if (l.includes('oauth')) return PER_CALL_CAPS_MS.OAUTH;
    if (l.includes('transactiontypes')) return PER_CALL_CAPS_MS.TXTYPES;
    if (l.includes('productlist')) return PER_CALL_CAPS_MS.PRODUCTLIST;
    return PER_CALL_CAPS_MS.RATECALC;
}

/**
 * @param {Object} config - axios request config (method/url/data/headers)
 * @param {Object} [opts]
 * @param {number} [opts.retries=3]       - number of retry attempts after the first try (5xx/network)
 * @param {number} [opts.baseDelayMs=400] - base backoff; delay = baseDelayMs * 2^attempt
 * @param {string} [opts.label='FirstAm'] - label used in log lines; also selects the per-call cap
 * @param {number} [opts.perCallCapMs]    - override the per-call timeout cap
 * @returns {Promise} axios response
 * @throws {UpstreamTimeoutError} when the call times out and cannot be retried within budget
 */
async function firstAmRequestWithRetry(config, opts = {}) {
    const { retries = 3, baseDelayMs = 400, label = 'FirstAm' } = opts;
    const perCallCapMs = opts.perCallCapMs || capForLabel(label);

    let lastError;
    let timeoutRetriesUsed = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const remaining = remainingBudgetMs();
        const timeoutMs = Math.min(perCallCapMs, remaining - SAFETY_MARGIN_MS);
        if (timeoutMs < MIN_CALL_MS) {
            console.error(
                `[${label}] Not sending request: request time budget exhausted ` +
                `(remaining=${remaining}ms, needed>=${MIN_CALL_MS + SAFETY_MARGIN_MS}ms)`
            );
            throw new UpstreamTimeoutError({
                upstream: label,
                timeoutMs: Math.max(timeoutMs, 0),
                elapsedMs: 0,
                exhausted: true,
                cause: lastError,
            });
        }

        // axios `timeout` is socket-idle based; the AbortController is the wall-clock guarantee.
        const controller = new AbortController();
        const guard = setTimeout(() => controller.abort(), timeoutMs + 250);
        const startedAt = Date.now();
        try {
            return await axios({ ...config, timeout: timeoutMs, signal: controller.signal });
        } catch (error) {
            lastError = error;
            const elapsedMs = Date.now() - startedAt;
            const status = error.response?.status;
            const isTimeout = TIMEOUT_CODES.has(error.code) || controller.signal.aborted;

            if (isTimeout) {
                const remainingNow = remainingBudgetMs();
                console.error(
                    `[${label}] Upstream timeout after ${elapsedMs}ms (limit ${timeoutMs}ms, ` +
                    `attempt ${attempt + 1}/${retries + 1}, budget remaining ${remainingNow}ms)`
                );
                // A hang that ran the full cap is more likely an outage than a blip: retry at most
                // once, and only if a full-size retry still fits in the budget.
                const canRetry =
                    attempt < retries &&
                    timeoutRetriesUsed < 1 &&
                    remainingNow - SAFETY_MARGIN_MS >= perCallCapMs;
                if (!canRetry) {
                    throw new UpstreamTimeoutError({
                        upstream: label, timeoutMs, elapsedMs, exhausted: false, cause: error,
                    });
                }
                timeoutRetriesUsed++;
                console.warn(`[${label} retry] Retrying once after timeout`);
                continue;
            }

            const isTransient = status === undefined || (status >= 500 && status < 600);
            const delay = baseDelayMs * Math.pow(2, attempt);
            const retryFitsBudget = remainingBudgetMs() - SAFETY_MARGIN_MS - delay >= MIN_CALL_MS;

            // Don't retry deterministic client errors (4xx) — they won't self-heal.
            if (!isTransient || attempt === retries || !retryFitsBudget) {
                if (isTransient) {
                    console.error(
                        `[${label} retry] Exhausted ${attempt} retries` +
                        `${retryFitsBudget ? '' : ' (no budget for another attempt)'}; ` +
                        `last status=${status ?? 'network-error'}`
                    );
                }
                // Surface the real upstream fault body for diagnosis.
                if (error.response) {
                    const body = typeof error.response.data === 'string'
                        ? error.response.data.substring(0, 2000)
                        : JSON.stringify(error.response.data).substring(0, 2000);
                    console.error(`[${label} retry] Upstream ${status} response body:`, body);
                }
                throw error;
            }

            console.warn(
                `[${label} retry] Transient failure (status=${status ?? 'network-error'}) ` +
                `on attempt ${attempt + 1}/${retries + 1}; retrying in ${delay}ms`
            );
            await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
            clearTimeout(guard);
        }
    }

    throw lastError;
}

module.exports = {
    firstAmRequestWithRetry,
    beginRequestBudget,
    remainingBudgetMs,
    upstreamTimeoutResponse,
    UpstreamTimeoutError,
};
