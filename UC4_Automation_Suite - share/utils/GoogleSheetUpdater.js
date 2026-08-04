'use strict';

/**
 * GoogleSheetUpdater — Option B (Apps Script Web App)
 * ─────────────────────────────────────────────────────────────────────────────
 * Posts UC4 process-flow results to a Google Apps Script Web App, which writes
 * status + comments into the team's Google Sheet with colour-coded formatting
 * matching columns N/O (Overnight Run + Comments).
 *
 * NO external npm packages required — uses Node.js built-in https module only.
 *
 * Setup steps (one-time):
 *   1. Open your Google Sheet → Extensions → Apps Script
 *   2. Replace all script content with the code from utils/AppsScript_SheetUpdater.gs
 *   3. Click Deploy → New Deployment → Type: Web App
 *      - Execute as:  Me
 *      - Who has access: Anyone
 *   4. Copy the Web App URL and paste it into .env.validation:
 *         GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
 *   5. Optionally set the tab name (default: "Critical for End to End Testing"):
 *         GOOGLE_SHEET_TAB=Critical for End to End Testing
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');
require('dotenv').config({ path: '.env.validation' });

// ── Status label map: FlowStatus emoji string → Google Sheet cell text ────────
const STATUS_LABELS = {
    '✅ Completed':     'Completed',
    '⛔ Blocked':       'Blocked',
    '⏳ In Progress':   'In Progress',
    '🔵 Active':        'In Progress',
    '🚫 Not Triggered': 'Yet to Start',
};

class GoogleSheetUpdater {
    /**
     * @param {string} [scriptUrl]    - Apps Script Web App URL (falls back to env var)
     * @param {string} [sheetTabName] - Sheet tab name (falls back to env var / default)
     */
    constructor(scriptUrl, sheetTabName) {
        this.scriptUrl    = scriptUrl    || process.env.GOOGLE_APPS_SCRIPT_URL || '';
        this.sheetTabName = sheetTabName || process.env.GOOGLE_SHEET_TAB       || 'Critical for End to End Testing';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Sends aggregated flow results to the Google Sheet via Apps Script Web App.
     * Non-fatal — logs warnings on failure and never throws.
     *
     * @param {Array} aggregatedStats   - From LogFetcher.aggregateJobStats()
     * @param {Array} failedJobRecords  - From readCsvFile(failedJobsCsvPath)
     */
    async update(aggregatedStats, failedJobRecords) {
        if (!this.scriptUrl) {
            console.log('[GoogleSheet] GOOGLE_APPS_SCRIPT_URL not configured — skipping sheet update.');
            return;
        }

        try {
            // Today's date label matching the sheet header format: "DD/MM/YY"
            const now = new Date();
            const dd  = String(now.getDate()).padStart(2, '0');
            const mm  = String(now.getMonth() + 1).padStart(2, '0');
            const yy  = String(now.getFullYear()).slice(-2);
            const dateLabel = `${dd}/${mm}/${yy}`;

            // Build failed-jobs lookup: JobName → [ObjectName, ...]
            const failedByFlow = {};
            for (const r of (failedJobRecords || [])) {
                if ((r.Status || '').toUpperCase() === 'NOT_TRIGGERED') continue;
                if (!failedByFlow[r.JobName]) failedByFlow[r.JobName] = [];
                const jobLabel = (r.ObjectName && r.ObjectName !== 'N/A') ? r.ObjectName : r.JobName;
                failedByFlow[r.JobName].push(jobLabel);
            }

            // Build flow payload array
            const flows = (aggregatedStats || []).map(stat => {
                const label      = STATUS_LABELS[stat.FlowStatus] || '';
                const failedJobs = failedByFlow[stat.JobName] || [];
                const comment    = this._buildComment(stat, failedJobs);
                return { jobName: stat.JobName, status: label, comment };
            });

            const payload = JSON.stringify({
                tabName:   this.sheetTabName,
                dateLabel,
                flows,
            });

            console.log(`[GoogleSheet] Posting ${flows.length} flows to Apps Script (tab: "${this.sheetTabName}")...`);
            const result = await this._post(this.scriptUrl, payload);

            if (result && result.success) {
                console.log(`[GoogleSheet] ✅ Sheet updated — ${result.updated || flows.length} rows written.`);
            } else {
                console.warn(`[GoogleSheet] ⚠️  Apps Script reported: ${(result && result.error) || 'unknown response'}`);
            }
        } catch (err) {
            console.warn(`[GoogleSheet] ⚠️  Non-fatal error updating sheet: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Builds the comment text written into the Google Sheet "Comments" column.
     *
     * Logic:
     *   Not Triggered → "Not triggered in overnight batch"
     *   Has failures  → "Failed Jobs :\n1)JobName\n2)JobName..."
     *   Completed     → "No Failures"
     *   In Progress / Active → "Waiting for <raw UC4 status>" or "yet to complete"
     *   Blocked       → raw UC4 status text or "Flow is blocked"
     *
     * @param {Object} stat       - Aggregated stat object (from aggregateJobStats)
     * @param {string[]} failedJobs - Names of failed child jobs for this flow
     * @returns {string}
     */
    _buildComment(stat, failedJobs) {
        const fs = stat.FlowStatus || '';

        if (fs === '🚫 Not Triggered') {
            return 'Not triggered in overnight batch';
        }

        if (failedJobs.length > 0) {
            // Both "Blocked" and "Completed with some failures" paths
            return 'Failed Jobs :\n' + failedJobs.map((j, i) => `${i + 1})${j}`).join('\n');
        }

        if (fs === '✅ Completed') {
            return 'No Failures';
        }

        if (fs === '⏳ In Progress' || fs === '🔵 Active') {
            const raw = (stat.rawUC4Status || '').trim();
            return raw ? `Waiting for ${raw}` : 'Process flow is yet to complete';
        }

        if (fs === '⛔ Blocked') {
            return (stat.rawUC4Status || '').trim() || 'Flow is blocked';
        }

        return '';
    }

    /**
     * POSTs JSON to the given URL, following up to 5 redirects (Google Apps Script
     * always redirects the first POST to script.googleusercontent.com).
     */
    _post(url, bodyStr, redirectCount = 0) {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) {
                return reject(new Error('Too many redirects from Apps Script endpoint'));
            }

            let parsed;
            try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

            const transport = parsed.protocol === 'https:' ? https : http;
            const options = {
                hostname: parsed.hostname,
                path:     parsed.pathname + parsed.search,
                method:   'POST',
                headers: {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                },
            };

            const req = transport.request(options, (res) => {
                // Follow redirect — Apps Script sends 302 on first POST
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); // drain response body
                    this._post(res.headers.location, bodyStr, redirectCount + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        // Apps Script may return HTML on error — treat 2xx as success
                        resolve({ success: res.statusCode >= 200 && res.statusCode < 300 });
                    }
                });
            });

            req.on('error', reject);
            req.write(bodyStr);
            req.end();
        });
    }
}

module.exports = GoogleSheetUpdater;
