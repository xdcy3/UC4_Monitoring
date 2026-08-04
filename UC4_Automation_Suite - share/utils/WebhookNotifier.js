/**
 * WebhookNotifier.js
 *
 * Requirement #4 Implementation: Modern Webhook Alerting
 *
 * Sends structured JSON payloads to Microsoft Teams or Slack webhooks.
 * Supports both Teams (Adaptive Card format) and Slack (Block Kit format).
 * Auto-detects the webhook type from the URL, or can be forced via options.
 *
 * Reads job data from the same CSV files used by LogFetcher/EmailNotifier,
 * so it can be plugged into the afterAll() hook alongside existing notifiers.
 *
 * Environment variables (add to .env.validation):
 *   TEAMS_WEBHOOK_URL  - Microsoft Teams Incoming Webhook URL
 *   SLACK_WEBHOOK_URL  - Slack Incoming Webhook URL
 *   (If both are set, Teams takes priority unless type is forced)
 */

const https = require('https');
const http = require('http');
const fsSync = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
require('dotenv').config({ path: '.env.validation' });

class WebhookNotifier {
    /**
     * @param {string} failedJobsCsvPath - Absolute path to the failed jobs output CSV
     * @param {string} timestamp         - Run timestamp string (e.g. '20260518')
     * @param {Object} [options]
     * @param {string} [options.webhookUrl] - Override the webhook URL (default: from env)
     * @param {string} [options.type]       - Force 'teams' | 'slack' (default: auto-detect)
     */
    constructor(failedJobsCsvPath, timestamp, options = {}) {
        this.failedJobsCsvPath = failedJobsCsvPath;
        this.allJobsCsvPath = path.join(path.dirname(failedJobsCsvPath), 'all_jobs_log.csv');
        this.timestamp = timestamp;

        this.webhookUrl =
            options.webhookUrl ||
            process.env.TEAMS_WEBHOOK_URL ||
            process.env.SLACK_WEBHOOK_URL;

        this.webhookType = options.type || this._detectWebhookType(this.webhookUrl);

        this.enabled = !!this.webhookUrl;
        if (!this.enabled) {
            console.warn('[WebhookNotifier] No webhook URL found. Set TEAMS_WEBHOOK_URL or SLACK_WEBHOOK_URL in .env.validation to enable webhook alerts.');
        }
    }

    // ─── Entry Point ────────────────────────────────────────────────────────

    /**
     * Reads CSV files, builds the payload, and fires the webhook.
     * Safe to call unconditionally – exits silently if not configured.
     */
    async processAndNotify() {
        if (!this.enabled) return;

        const failedJobs    = this._readCsvFile(this.failedJobsCsvPath);
        const allJobRecords = this._readCsvFile(this.allJobsCsvPath);

        // Guard: skip if run data is insufficient (mirrors LogFetcher threshold)
        if (allJobRecords.length < 2) {
            console.log(`[WebhookNotifier] Skipping webhook: all_jobs_log.csv has only ${allJobRecords.length} record(s).`);
            return;
        }

        const aggregatedStats = this._aggregateJobStats(allJobRecords);

        try {
            let payload;
            if (this.webhookType === 'slack') {
                payload = this._buildSlackPayload(failedJobs, aggregatedStats, this.timestamp);
            } else {
                // Default: Teams Adaptive Card (also generic JSON for other webhooks)
                payload = this._buildTeamsPayload(failedJobs, aggregatedStats, this.timestamp);
            }

            console.log(`[WebhookNotifier] Sending ${this.webhookType} webhook (${failedJobs.length} failed job(s))...`);
            await this._sendWebhook(payload);
            console.log('[WebhookNotifier] Webhook delivered successfully.');
        } catch (error) {
            // Webhook failure must never crash the main test run
            console.error(`[WebhookNotifier] Webhook delivery failed: ${error.message}`);
        }
    }

    // ─── Payload Builders ────────────────────────────────────────────────────

    /**
     * Builds a Microsoft Teams Adaptive Card payload.
     * Compatible with the Teams Incoming Webhook connector format.
     *
     * The JSON structure includes:
     *  - Run summary (per process flow: Total / Completed / In-Progress / Failed)
     *  - Per-failed-job detail block with:
     *      • Status
     *      • Host
     *      • Error Reason (scraped by Req #1 - scrapeJobErrorDetails)
     *      • Auto-Restarted flag (from Req #2 - attemptJobRestart)
     */
    _buildTeamsPayload(failedJobs, aggregatedStats, timestamp) {
        const hasFailures = failedJobs.length > 0;
        const title       = hasFailures
            ? `❌ UC4 Alert — ${failedJobs.length} Failed Job(s) Detected`
            : `✅ UC4 Run Complete — All Jobs Successful`;

        // ── Summary section ──────────────────────────────────────────────────
        const summaryBlocks = aggregatedStats.map(stat => ({
            type: 'FactSet',
            facts: [
                { title: 'Process Flow:',   value: `**${stat.JobName}**` },
                { title: 'Total Jobs:',     value: String(stat.Total) },
                { title: '✅ Completed:',   value: String(stat.Completed) },
                { title: '🕐 In Progress:', value: String(stat.InProgress) },
                { title: '❌ Failed:',      value: String(stat.Failed)     },
            ],
        }));

        // ── Failed job detail cards ───────────────────────────────────────────
        const failedJobBlocks = failedJobs.flatMap(job => [
            {
                type: 'Container',
                style: 'attention',
                bleed: true,
                items: [
                    {
                        type: 'TextBlock',
                        text: `**${job.ObjectName || 'N/A'}**`,
                        weight: 'Bolder',
                        wrap: true,
                    },
                    {
                        type: 'FactSet',
                        facts: [
                            { title: 'Process Flow:',   value: job.JobName       || 'N/A' },
                            { title: 'Final Status:',   value: job.FinalStatus   || 'N/A' },
                            { title: 'Host:',           value: job.Host          || 'N/A' },
                            // Requirement #1: Error reason extracted from UI Details panel
                            { title: 'Error Reason:',   value: job.ErrorReason   || 'N/A' },
                            // Requirement #2: Whether auto-restart was triggered
                            { title: 'Auto-Restarted:', value: job.RestartTriggered === 'Yes' ? '✅ Yes' : '❌ No' },
                            { title: 'Detected At:',    value: job.ScriptRunDate  || timestamp },
                        ],
                    },
                ],
            },
            // Thin separator between jobs
            { type: 'Separator' },
        ]);

        // ── Adaptive Card body ───────────────────────────────────────────────
        const adaptiveCard = {
            type:      'AdaptiveCard',
            $schema:   'http://adaptivecards.io/schemas/adaptive-card.json',
            version:   '1.4',
            body: [
                {
                    type:   'TextBlock',
                    size:   'Large',
                    weight: 'Bolder',
                    color:  hasFailures ? 'Attention' : 'Good',
                    text:   title,
                    wrap:   true,
                },
                {
                    type:     'TextBlock',
                    text:     `Run Timestamp: **${timestamp}**`,
                    isSubtle: true,
                    wrap:     true,
                },
                { type: 'Separator' },
                {
                    type:   'TextBlock',
                    text:   '**📊 Run Summary**',
                    weight: 'Bolder',
                    size:   'Medium',
                },
                ...summaryBlocks,
                ...(hasFailures
                    ? [
                          { type: 'Separator' },
                          {
                              type:   'TextBlock',
                              text:   '**🚨 Failed Job Details**',
                              weight: 'Bolder',
                              size:   'Medium',
                              color:  'Attention',
                          },
                          ...failedJobBlocks,
                      ]
                    : []),
            ],
        };

        // Teams Incoming Webhook wraps the card in an "attachments" envelope
        return {
            type: 'message',
            attachments: [
                {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    contentUrl:  null,
                    content:     adaptiveCard,
                },
            ],
        };
    }

    /**
     * Builds a Slack Block Kit payload.
     * Compatible with Slack Incoming Webhooks.
     *
     * Includes the same error-reason and restart-triggered fields so
     * Slack recipients see the full picture from requirements #1 and #2.
     */
    _buildSlackPayload(failedJobs, aggregatedStats, timestamp) {
        const hasFailures = failedJobs.length > 0;
        const headerText  = hasFailures
            ? `❌ UC4 Alert: ${failedJobs.length} Failed Job(s) Detected`
            : `✅ UC4 Run Complete: All Jobs Successful`;

        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text: headerText, emoji: true },
            },
            {
                type:     'context',
                elements: [{ type: 'mrkdwn', text: `*Run Timestamp:* ${timestamp}` }],
            },
            { type: 'divider' },
            {
                type: 'section',
                text: { type: 'mrkdwn', text: '*📊 Run Summary*' },
            },
        ];

        // One summary block per process flow
        for (const stat of aggregatedStats) {
            blocks.push({
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*Process Flow:*\n${stat.JobName}` },
                    { type: 'mrkdwn', text: `*Total Jobs:*\n${stat.Total}`     },
                    { type: 'mrkdwn', text: `✅ *Completed:*\n${stat.Completed}` },
                    { type: 'mrkdwn', text: `🕐 *In Progress:*\n${stat.InProgress}` },
                    { type: 'mrkdwn', text: `❌ *Failed:*\n${stat.Failed}`     },
                ],
            });
        }

        if (hasFailures) {
            blocks.push({ type: 'divider' });
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '*🚨 Failed Job Details*' },
            });

            for (const job of failedJobs) {
                const restarted = job.RestartTriggered === 'Yes' ? '✅ Yes' : '❌ No';
                blocks.push({
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: [
                            `*Job:* \`${job.ObjectName || 'N/A'}\``,
                            `*Process Flow:* ${job.JobName      || 'N/A'}`,
                            `*Final Status:* ${job.FinalStatus  || 'N/A'}`,
                            `*Host:* ${job.Host                 || 'N/A'}`,
                            // Requirement #1 – error reason from UI log scraping
                            `*Error Reason:* ${job.ErrorReason  || 'N/A'}`,
                            // Requirement #2 – restart attempt result
                            `*Auto-Restarted:* ${restarted}`,
                            `*Detected At:* ${job.ScriptRunDate || timestamp}`,
                        ].join('\n'),
                    },
                });
                blocks.push({ type: 'divider' });
            }
        }

        return { blocks };
    }

    // ─── HTTP Transport ──────────────────────────────────────────────────────

    /**
     * Sends the JSON payload to the webhook URL.
     * Uses Node.js built-in https/http — no extra dependencies required.
     * Rejects on non-2xx HTTP status or request errors.
     */
    _sendWebhook(payload) {
        return new Promise((resolve, reject) => {
            const body      = JSON.stringify(payload);
            const parsedUrl = new URL(this.webhookUrl);
            const isHttps   = parsedUrl.protocol === 'https:';
            const transport = isHttps ? https : http;

            const options = {
                hostname: parsedUrl.hostname,
                port:     parsedUrl.port || (isHttps ? 443 : 80),
                path:     parsedUrl.pathname + parsedUrl.search,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = transport.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', err => reject(new Error(`Request error: ${err.message}`)));

            // 15-second network timeout – must not block the test process
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('Webhook request timed out after 15 seconds'));
            });

            req.write(body);
            req.end();
        });
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    _detectWebhookType(url) {
        if (!url) return 'unknown';
        if (url.includes('webhook.office.com') || url.includes('office365.com')) return 'teams';
        if (url.includes('hooks.slack.com')) return 'slack';
        // Default to Teams format for generic webhooks
        return 'teams';
    }

    _readCsvFile(filePath) {
        try {
            const csvContent = fsSync.readFileSync(filePath, { encoding: 'utf8' });
            return parse(csvContent, { columns: true, skip_empty_lines: true });
        } catch (err) {
            console.error(`[WebhookNotifier] Could not read CSV: ${filePath}. Error: ${err.message}`);
            return [];
        }
    }

    /**
     * Mirrors the same aggregation logic used by LogFetcher and EmailNotifier
     * to ensure consistent summary statistics in the webhook payload.
     */
    _aggregateJobStats(allJobsRecords) {
        const stats = {};
        for (const record of allJobsRecords) {
            const { JobID, JobName, Status } = record;
            if (!JobID) continue;

            if (!stats[JobID]) {
                stats[JobID] = { JobID, JobName, Total: 0, Completed: 0, InProgress: 0, Failed: 0 };
            }

            stats[JobID].Total++;
            const s = Status ? Status.toUpperCase() : '';

            if (s.includes('ENDED_OK') || s.includes('ENDED_INACTIVE')) {
                stats[JobID].Completed++;
            } else if (s.includes('WAITING FOR PREDECESSOR') || s.includes('WAITING FOR START TIME')) {
                stats[JobID].InProgress++;
            } else if (
                s.includes('ENDED_NOT_OK') || s.includes('BLOCKED') ||
                s.includes('ENDED_CANCEL') || s.includes('ABORTED') ||
                s.includes('STATUS BLOCKED MANUALLY REMOVED') ||
                s.includes('WAITING FOR EXTERNAL') || s.includes('WAITING FOR PARALLEL') ||
                s.includes('FAULTED')
            ) {
                stats[JobID].Failed++;
            }
        }
        return Object.values(stats);
    }
}

module.exports = WebhookNotifier;
