/**
 * LogFetcher.js  —  Post-Run Reporting: PDF Generation, Email Dispatch, Sheet Update
 *
 * PURPOSE:
 * Processes all UC4 job results captured by a Playwright spec and produces
 * the full end-of-run report package:
 * 1. ProcessFlowRunStatus.pdf  — full job-detail report for every flow
 * 2. FailureList.pdf           — concise failure + slow-jobs report (when needed)
 * 3. HTML email                — sent via Gmail SMTP to the team distribution list
 * 4. Google Sheet update       — via Apps Script Web App (optional, env-gated)
 *
 * ENTRY POINT:
 * Call processFailedJobs(parentStatuses, inputFlowRecords) from the spec's afterAll hook.
 *
 * INPUT FILES (written by the spec during the run):
 * test-data/failed_<SuiteName>.csv  — failed jobs only
 * test-data/all_jobs_log.csv        — every sub-job captured across all flows
 *
 * OUTPUT FILES:
 * test-data/ProcessFlowRunStatus.pdf
 * test-data/FailureList.pdf
 *
 * CONFIGURATION (.env.validation):
 * EMAIL_USER             — Gmail sender address
 * EMAIL_PASS             — Gmail app password
 * EMAIL_TO               — Recipient address
 * GOOGLE_APPS_SCRIPT_URL — Optional Apps Script Web App URL for sheet updates
 * GOOGLE_SHEET_TAB       — Optional sheet tab name
 */

const fsSync = require('fs');
const path   = require('path');
const { parse }          = require('csv-parse/sync');
const nodemailer         = require('nodemailer');
const GoogleSheetUpdater = require('./GoogleSheetUpdater');
require('dotenv').config({ path: '.env.validation' });

class LogFetcher {
    /**
     * @param {string} failedJobsCsvPath - Absolute path to the failed-jobs CSV written by the spec
     * @param {string} timestamp         - Run date string used for file naming ('YYYYMMDD')
     * @param {number} [suiteStartTime]  - Date.now() captured before the suite started (for duration calc)
     *
     * Companion file paths are derived from failedJobsCsvPath:
     * all_jobs_log.csv         — sibling in the same directory
     * ProcessFlowRunStatus.pdf — output PDF in the same directory
     * FailureList.pdf          — output PDF in the same directory
     */
    constructor(failedJobsCsvPath, timestamp, suiteStartTime = null) {
        this.failedJobsCsvPath = failedJobsCsvPath;
        this.allJobsCsvPath    = path.join(path.dirname(failedJobsCsvPath), 'all_jobs_log.csv');
        this.allJobsPdfPath    = path.join(path.dirname(failedJobsCsvPath), 'ProcessFlowRunStatus.pdf');
        this.failureListPdfPath = path.join(path.dirname(failedJobsCsvPath), 'FailureList.pdf');
        this.timestamp         = timestamp;

        this.emailAuth = {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        };

        this.emailRecipient = process.env.EMAIL_TO;
        // Use the passed-in suite start time (captured before tests ran) so the
        // duration reflects the full automation run, not just post-processing time.
        this.testStartTime  = suiteStartTime || Date.now();
        this.totalDuration  = null;

        this.validateCredentials();
    }

    // ─── VALIDATION ──────────────────────────────────────────────────────────

    /**
     * Validates required environment variables at construction time.
     * Throws immediately so misconfiguration is caught before tests run,
     * not silently at email-send time.
     */
    validateCredentials() {
        if (!this.emailAuth.user || !this.emailAuth.pass) {
            throw new Error('Email username or password not found in the environment file.');
        }
        if (!this.emailRecipient) {
            throw new Error('EMAIL_TO not found in the environment file.');
        }
    }

    // ─── MAIN ENTRY POINT ────────────────────────────────────────────────────

    /**
     * Main entry point — called from the spec's afterAll hook.
     *
     * Orchestrates the full post-run pipeline:
     * 1. Read both CSV output files from disk.
     * 2. Aggregate per-flow statistics (Completed / In Progress / Blocked).
     * 3. Generate ProcessFlowRunStatus.pdf.
     * 4. Identify slow jobs (≥30 min) and generate FailureList.pdf if needed.
     * 5. Send a success email or a failure/slow-jobs alert email with PDFs attached.
     * 6. (Optional) Post results to the Google Sheet via Apps Script Web App.
     *
     * @param {Object} parentStatuses   - Map of JobID → pipe-delimited UC4 status string
     * (e.g. { '1': 'ENDED_OK|TODAY_ACTIVE|RAW:...|ACT:...' })
     * @param {Array}  inputFlowRecords - Rows from the input CSV (ensures flows with no child
     * jobs still appear in the summary)
     */
    async processFailedJobs(parentStatuses = {}, inputFlowRecords = []) {
        console.log('--- Starting Post-Test Pipeline ---');

        const failedJobRecords = this.readCsvFile(this.failedJobsCsvPath);
        const allJobRecords    = this.readCsvFile(this.allJobsCsvPath);

        // Guard: need at least 2 rows (header + 1 data row) to produce a meaningful report
        if (allJobRecords.length < 2) {
            console.log(`Skipping email notification: all_jobs_log.csv has only ${allJobRecords.length} record(s).`);
            return;
        }

        const aggregatedStats = this.aggregateJobStats(allJobRecords, parentStatuses, inputFlowRecords);

        // Generate the full run status PDF
        await this.generatePdf(allJobRecords, aggregatedStats);

        // Identify slow jobs (runtime >= 45 mins) and build FailureList PDF
        const slowJobs    = this._getSlowJobs(allJobRecords);
        const hasFailures = failedJobRecords.length > 0;
        const hasSlowJobs = slowJobs.length > 0;
        if (hasFailures || hasSlowJobs) {
            await this.generateFailureListPdf(failedJobRecords, slowJobs, aggregatedStats);
        }

        // Calculate total run duration and capture formatted start/end times in strict AEST
        const _suiteEndTime = Date.now();
        this.suiteStartFormatted = this._formatDateTime(this.testStartTime);
        this.suiteEndFormatted   = this._formatDateTime(_suiteEndTime);
        const _durMins = Math.round((_suiteEndTime - this.testStartTime) / 60000);
        this.totalDuration = _durMins < 1 ? '< 1 min' : `${_durMins} min`;
        console.log(`Total run duration: ${this.totalDuration}`);

        if (!hasFailures && !hasSlowJobs) {
            console.log('No failed or slow jobs found. Sending success email.');
            await this.sendSuccessEmail(aggregatedStats);
            return;
        }

        console.log('Sending failure summary email...');
        await this.sendFailureEmail(failedJobRecords, aggregatedStats, slowJobs);
        console.log('--- Post-Test Pipeline Complete ---');

        // ── Google Sheet update (non-fatal, runs after email) ────────────────
        const sheetUpdater = new GoogleSheetUpdater();
        await sheetUpdater.update(aggregatedStats, failedJobRecords);
    }

    /**
     * Helper to compute true mathematical AEST components using IANA timezone conversion.
     * @returns {string} Formatted timestamp: DD-MM-YYYY hh:mm AM/PM AEST
     */
    _getDmailerSubjectTimestamp() {
        const date = new Date();
        const options = {
            timeZone: 'Australia/Sydney',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        };

        const formattedParts = new Intl.DateTimeFormat('en-AU', options).formatToParts(date);
        const parts = {};
        formattedParts.forEach(({ type, value }) => parts[type] = value);

        const ampm = (parts.dayPeriod || '').toUpperCase();
        return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute} ${ampm} AEST`;
    }

    /**
     * Formats a Unix timestamp as 'DD/MM/YYYY, HH:MM:SS AEST' strictly forced to Australia/Sydney time.
     * Used to display suite start and end times in emails.
     *
     * @param {number} ts - Unix timestamp (Date.now())
     * @returns {string}
     */
    _formatDateTime(ts) {
        if (!ts) return '—';
        const date = new Date(ts);
        const options = {
            timeZone: 'Australia/Sydney',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        };

        const formattedParts = new Intl.DateTimeFormat('en-AU', options).formatToParts(date);
        const parts = {};
        formattedParts.forEach(({ type, value }) => parts[type] = value);

        return `${parts.day}/${parts.month}/${parts.year}, ${parts.hour}:${parts.minute}:${parts.second} AEST`;
    }

    /**
     * Converts a UC4 CSV datetime string ("M/D/YYYY H:MM:SS AM/PM") to the
     * corporate standard format "DD/MM/YYYY HH:MM:SS AEST" (24-hour).
     * Returns the original string unchanged if the format is not recognised.
     *
     * @param {string} s - e.g. "5/22/2026 11:46:06 PM"
     * @returns {string}  e.g. "22/05/2026 23:46:06 AEST"
     */
    _fmtCsvDatetime(s) {
        if (!s || s === 'N/A') return s || 'N/A';
        const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i);
        if (!m) return s;
        let [, month, day, year, hour, min, sec, ampm] = m;
        
        let pA = parseInt(month, 10);
        let pB = parseInt(day, 10);
        let d = pA > 12 ? pA : pB;
        let mo = pA > 12 ? pB : pA;

        let h = parseInt(hour, 10);
        if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
        
        return `${String(d).padStart(2,'0')}/${String(mo).padStart(2,'0')}/${year} ${String(h).padStart(2,'0')}:${min}:${sec} AEST`;
    }

    /**
     * Reads a CSV file from disk and returns parsed rows as an array of objects.
     * Column names come from the CSV header row.
     * Returns an empty array (and logs an error) if the file is missing or unreadable.
     *
     * @param {string} filePath
     * @returns {Array<Object>}
     */
    readCsvFile(filePath) {
        try {
            const csvContent = fsSync.readFileSync(filePath, { encoding: 'utf8' });
            return parse(csvContent, { columns: true, skip_empty_lines: true });
        } catch (err) {
            console.error(`Failed to read CSV: ${filePath}. Error: ${err.message}`);
            return [];
        }
    }

    // ─── STATUS AGGREGATION  (Completed / In Progress / Blocked) ──────────────

    /**
     * Aggregates child-job rows from all_jobs_log.csv into one summary per flow.
     *
     * @param {Array}  allJobRecords    - All rows from all_jobs_log.csv
     * @param {Object} parentStatuses   - Map of JobID → pipe-delimited status string
     * @param {Array}  inputFlowRecords - Input CSV rows (ensures all flows appear in output)
     * @returns {Array<Object>} One aggregated stat object per process flow
     */
    aggregateJobStats(allJobRecords, parentStatuses = {}, inputFlowRecords = []) {
        const stats = {};
        for (const record of allJobRecords) {
            const { JobID, JobName, Status, ObjectName } = record;
            if (!JobID) continue;

            if (!stats[JobID]) {
                stats[JobID] = { JobID, JobName, Total: 0, Completed: 0, InProgress: 0, Blocked: 0, NotTriggered: false, LastRanDate: null };
            }

            stats[JobID].Total++;
            const s = (Status || '').toUpperCase();

            if (s === 'NOT_TRIGGERED') {
                stats[JobID].NotTriggered = true;
                stats[JobID].Total--;       // placeholder row — not a real job
                stats[JobID].LastRanDate = ObjectName && ObjectName !== 'N/A' ? ObjectName : null;
            } else if (s.includes('ENDED_OK') || s.includes('ENDED_INACTIVE')) {
                stats[JobID].Completed++;
            } else if (
                s.includes('RUNNING')            ||
                s.includes('WAITING FOR START')  ||
                s.includes('WAITING FOR PREDECESSOR') ||
                s.includes('QUEUED')
            ) {
                stats[JobID].InProgress++;
            } else if (
                s.includes('ENDED_NOT_OK')       ||
                s.includes('ENDED_CANCEL')        ||
                s.includes('FAULTED')             ||
                s.includes('ABORTED')             ||
                s === 'BLOCKED'                   ||
                s.includes('STATUS BLOCKED')      ||
                s.includes('WAITING FOR EXTERNAL') ||
                s.includes('WAITING FOR PARALLEL') ||
                s.includes('EXTRACTIONERROR')
            ) {
                stats[JobID].Blocked++;
            }
        }
        for (const r of inputFlowRecords) {
            if (!stats[r.JobID] && parentStatuses[r.JobID] !== undefined) {
                stats[r.JobID] = {
                    JobID: r.JobID, JobName: r.JobName,
                    Total: 0, Completed: 0, InProgress: 0, Blocked: 0,
                    NotTriggered: false, LastRanDate: null
                };
            }
        }
        return Object.values(stats).map(s => {
            const rawParentStr = parentStatuses[s.JobID] || parentStatuses[s.JobName] || parentStatuses[String(s.JobID)] || '';
            const todayActive    = rawParentStr.toUpperCase().includes('|TODAY_ACTIVE');
            const rawStatusMatch = rawParentStr.match(/\|RAW:([^|]+)/);
            const rawUC4Status   = rawStatusMatch ? rawStatusMatch[1].trim() : '';
            const actTimeMatch   = rawParentStr.match(/\|ACT:([^|]+)/);
            const activationTime = actTimeMatch   ? actTimeMatch[1].trim()   : '';
            const cleanParent    = rawParentStr.split('|')[0].trim().toUpperCase();
            let FlowStatus;
            if (cleanParent) {
                if (cleanParent === 'NOT_TRIGGERED' || s.NotTriggered) {
                    FlowStatus = '🚫 Not Triggered';
                } else if (cleanParent.includes('ENDED_OK') || cleanParent.includes('ENDED_INACTIVE')) {
                    FlowStatus = '✅ Completed';
                } else if (cleanParent === 'ACTIVE' || (todayActive && (cleanParent.includes('ENDED_OK') || cleanParent.includes('ENDED_INACTIVE') || !cleanParent))) {
                    FlowStatus = '🔵 Active';
                } else if (cleanParent.includes('RUNNING')) {
                    FlowStatus = '⏳ In Progress';
                } else {
                    FlowStatus = '⛔ Blocked';
                }
            } else {
                FlowStatus = s.Blocked > 0         ? '⛔ Blocked'
                           : s.InProgress > 0     ? '⏳ In Progress'
                           : (s.Total > 0 && s.Completed === s.Total) ? '✅ Completed'
                           : '—';
            }
            return { ...s, FlowStatus, todayActive, rawUC4Status, activationTime };
        });
    }

    /**
     * Generates ProcessFlowRunStatus.pdf using a headless Chromium instance.
     */
    async generatePdf(allJobRecords, aggregatedStats) {
        try {
            const { chromium } = require('@playwright/test');
            const html    = this.buildPdfHtml(allJobRecords, aggregatedStats);
            const browser = await chromium.launch({ headless: true });
            const page    = await browser.newPage();
            await page.setContent(html, { waitUntil: 'networkidle' });
            await page.pdf({
                path:            this.allJobsPdfPath,
                format:          'A4',
                landscape:       true,
                printBackground: true,
                margin:          { top: '12mm', bottom: '12mm', left: '8mm', right: '8mm' },
            });
            await browser.close();
            console.log(`PDF report generated: ${this.allJobsPdfPath}`);
        } catch (err) {
            console.warn(`PDF generation failed (non-fatal): ${err.message}`);
        }
    }

    /**
     * Builds the HTML string rendered into ProcessFlowRunStatus.pdf.
     */
    buildPdfHtml(allJobRecords, aggregatedStats) {
        const runDate    = this._formatDateTime(Date.now());
        const totalFlows = aggregatedStats.length;
        const totalJobs  = allJobRecords.length;

        const summaryRows = aggregatedStats.map((r, i) => {
            const blockedStyle = r.Blocked > 0 ? 'color:#dc2626;font-weight:700;' : 'color:#16a34a;font-weight:700;';
            const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
            const pdfFlowStatus = r.FlowStatus === '⛔ Blocked'
                ? `<span style="display:inline-block;background:#dc2626;color:#ffffff;font-weight:700;font-size:12px;padding:5px 11px;border-radius:6px;white-space:nowrap;">⛔ Blocked</span>`
                : r.FlowStatus === '⏳ In Progress'
                ? `<span style="display:inline-block;background:#d97706;color:#ffffff;font-weight:700;font-size:12px;padding:5px 11px;border-radius:6px;white-space:nowrap;">⏳ In Progress</span>`
                : r.FlowStatus === '✅ Completed'
                ? `<span style="display:inline-block;background:#16a34a;color:#ffffff;font-weight:700;font-size:12px;padding:5px 11px;border-radius:6px;white-space:nowrap;">✅ Completed</span>`
                : r.FlowStatus === '🚫 Not Triggered'
                ? `<span style="display:inline-block;background:#b45309;color:#ffffff;font-weight:700;font-size:12px;padding:5px 11px;border-radius:6px;white-space:nowrap;">🚫 Not Triggered</span>`
                : r.FlowStatus === '🔵 Active'
                ? `<span style="display:inline-block;background:#0369a1;color:#ffffff;font-weight:700;font-size:12px;padding:5px 11px;border-radius:6px;white-space:nowrap;">🔵 Active</span>`
                : `<span style="display:inline-block;background:#64748b;color:#ffffff;font-weight:700;font-size:12px;padding:5px 11px;border-radius:6px;white-space:nowrap;">—</span>`;
            return `
            <tr style="background:${bg};">
                <td style="padding:11px 12px;border:1px solid #e2e8f0;font-size:13px;color:#111827;font-weight:700;text-align:center;">${r.JobID}</td>
                <td style="padding:11px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#111827;word-wrap:break-word;overflow-wrap:break-word;">${r.JobName}</td>
                <td style="padding:11px 12px;border:1px solid #e2e8f0;text-align:center;">${pdfFlowStatus}</td>
                <td style="padding:11px 12px;border:1px solid #e2e8f0;font-size:15px;text-align:center;color:#111827;font-weight:700;">${r.NotTriggered ? '—' : r.Total}</td>
                <td style="padding:11px 12px;border:1px solid #e2e8f0;font-size:15px;text-align:center;color:#16a34a;font-weight:700;">${r.Completed}</td>
                <td style="padding:11px 12px;border:1px solid #e2e8f0;font-size:15px;text-align:center;color:#d97706;font-weight:700;">${r.InProgress}</td>
                <td style="padding:11px 12px;border:1px solid #e2e8f0;font-size:15px;text-align:center;font-weight:700;${blockedStyle}">${r.Blocked}</td>
            </tr>`;
        }).join('');

        const statusBadge = (s) => {
            const u = (s || '').toUpperCase();
            let bg = '#e2e8f0', color = '#374151';
            if (u.includes('ENDED_OK'))       { bg = '#dcfce7'; color = '#15803d'; }
            else if (u.includes('ENDED_INACTIVE')) { bg = '#dbeafe'; color = '#1d4ed8'; }
            else if (u === 'NOT_TRIGGERED')   { bg = '#fef3c7'; color = '#92400e'; }
            else if (u.includes('ENDED_NOT_OK') || u.includes('ABORTED') || u.includes('BLOCKED') || u.includes('FAULTED') || u.includes('ENDED_CANCEL')) {
                bg = '#fee2e2'; color = '#b91c1c';
            }
            const label = u === 'NOT_TRIGGERED' ? 'NOT TRIGGERED' : (s || 'N/A').replace(/ - .*/, '').trim();
            return `<span style="display:inline-block;padding:5px 11px;border-radius:5px;background:${bg};color:${color};font-weight:700;font-size:12px;white-space:nowrap;letter-spacing:0.2px;">${label}</span>`;
        };

        const isSlowRuntime = (rt) => {
            if (!rt || rt === 'N/A') return false;
            const m = rt.match(/^(\d+):(\d{2}):\d{2}$/);
            if (!m) return false;
            return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) >= 45;
        };

        const safeText = (v) => (v || 'N/A').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const groups = [];
        const groupMap = {};
        for (const r of allJobRecords) {
            const key = r.JobID;
            if (!groupMap[key]) {
                groupMap[key] = { jobId: r.JobID, jobName: r.JobName, records: [] };
                groups.push(groupMap[key]);
            }
            groupMap[key].records.push(r);
        }

        const detailRows = groups.map((g) => {
            const stat = aggregatedStats.find(s => String(s.JobID) === String(g.jobId)) || {};
            const flowStatusHtml = stat.FlowStatus === '⛔ Blocked'
                ? `<span style="display:inline-block;background:#dc2626;color:#ffffff;font-weight:700;font-size:12px;padding:3px 9px;border-radius:5px;">⛔ Blocked</span>`
                : stat.FlowStatus === '⏳ In Progress'
                ? `<span style="display:inline-block;background:#d97706;color:#ffffff;font-weight:700;font-size:12px;padding:3px 9px;border-radius:5px;">⏳ In Progress</span>`
                : stat.FlowStatus === '✅ Completed'
                ? `<span style="display:inline-block;background:#16a34a;color:#ffffff;font-weight:700;font-size:12px;padding:3px 9px;border-radius:5px;">✅ Completed</span>`
                : stat.FlowStatus === '🚫 Not Triggered'
                ? `<span style="display:inline-block;background:#b45309;color:#ffffff;font-weight:700;font-size:12px;padding:3px 9px;border-radius:5px;">🚫 Not Triggered</span>`
                : `<span style="display:inline-block;background:#475569;color:#ffffff;font-weight:700;font-size:12px;padding:3px 9px;border-radius:5px;">—</span>`;

            const headerRow = `
            <tr style="background:#1e3a5f;page-break-inside:avoid;">
                <td colspan="7" style="padding:8px 12px;border:1px solid #1e40af;">
                    <table width="100%" cellpadding="0" cellspacing="0"><tr>
                        <td style="font-size:14px;font-weight:700;color:#ffffff;letter-spacing:0.3px;">
                            Flow&nbsp;${safeText(g.jobId)}&nbsp;&nbsp;•&nbsp;&nbsp;${safeText(g.jobName)}
                        </td>
                        <td style="text-align:right;font-size:13px;color:#cbd5e1;white-space:nowrap;">
                            ${stat.NotTriggered ? 'Not run' : `${g.records.length}&nbsp;jobs`}&nbsp;&nbsp;&nbsp;${flowStatusHtml}
                        </td>
                    </tr></table>
                </td>
            </tr>`;

            const jobRows = g.records.map((r, i) => {
                const u = (r.Status || '').toUpperCase();
                let rowBg = i % 2 === 0 ? '#ffffff' : '#f0f4f8';
                if (u === 'NOT_TRIGGERED') {
                    rowBg = '#fffbeb';
                } else if (u.includes('ENDED_NOT_OK') || u.includes('ABORTED') || (u === 'BLOCKED') || u.includes('FAULTED')) {
                    rowBg = '#fff0f0';
                }
                const runtimeStyle = isSlowRuntime(r.Runtime) ? 'background:#ef4444;color:#ffffff;font-weight:700;border-radius:3px;' : '';
                const cellBase = 'padding:10px 12px;border:1px solid #e2e8f0;font-size:12px;color:#111827;';
                return `
                <tr style="background:${rowBg};">
                    <td style="${cellBase}text-align:center;font-weight:700;border-left:3px solid #1e3a5f;">${safeText(r.JobID)}</td>
                    <td style="${cellBase}word-break:break-word;font-family:monospace;font-size:11.5px;">${safeText(r.ObjectName)}</td>
                    <td style="${cellBase}font-family:monospace;font-size:11.5px;word-break:break-all;">${safeText(r.RunID)}</td>
                    <td style="padding:10px 12px;border:1px solid #e2e8f0;">${statusBadge(r.Status)}</td>
                    <td style="${cellBase}white-space:nowrap;">${safeText(r.StartTime)}</td>
                    <td style="${cellBase}white-space:nowrap;">${safeText(r.EndTime)}</td>
                    <td style="${cellBase}text-align:center;white-space:nowrap;font-weight:700;${runtimeStyle}">${safeText(r.Runtime)}</td>
                </tr>`;
            }).join('');

            return headerRow + jobRows;
        }).join('');

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; font-size: 13px; background: #f1f5f9; color: #1e293b; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @media print {
    thead { display: table-header-group; }
    tr    { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div style="background:linear-gradient(135deg,#0f2027 0%,#203a43 50%,#1e3a5f 100%);padding:14px 20px;display:flex;justify-content:space-between;align-items:center;">
  <div>
    <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:0.5px;">NONPROD &mdash; UC4 Process Flow Automation</div>
    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">Automated Run Report &nbsp;|&nbsp; Generated: ${runDate}</div>
  </div>
  <div style="text-align:right;">
    <div style="font-size:12px;color:#cbd5e1;">Total Process Flows: <b style="color:#fff;">${totalFlows}</b></div>
    <div style="font-size:12px;color:#cbd5e1;">Total Jobs Processed: <b style="color:#fff;">${totalJobs}</b></div>
  </div>
</div>
<div style="padding:12px 16px 6px;">
  <div style="font-size:14px;font-weight:700;color:#1e3a5f;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;border-left:5px solid #1e3a5f;padding-left:10px;">Run Summary by Process Flow</div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;">
    <thead>
      <tr style="background:linear-gradient(90deg,#1e3a5f,#2563eb);">
        <th style="padding:12px 12px;font-size:13px;color:#ffffff;text-align:center;border:1px solid #1e40af;width:5%;font-weight:700;">Flow ID</th>
        <th style="padding:12px 12px;font-size:13px;color:#ffffff;text-align:left;border:1px solid #1e40af;width:27%;font-weight:700;">Process Flow Name</th>
        <th style="padding:12px 12px;font-size:13px;color:#ffffff;text-align:center;border:1px solid #1e40af;width:18%;font-weight:700;">Flow Status</th>
        <th style="padding:12px 12px;font-size:13px;color:#ffffff;text-align:center;border:1px solid #1e40af;width:10%;font-weight:700;">Total Jobs</th>
        <th style="padding:12px 12px;font-size:13px;color:#4ade80;text-align:center;border:1px solid #1e40af;width:13%;font-weight:700;">✔ Completed</th>
        <th style="padding:12px 12px;font-size:13px;color:#fde68a;text-align:center;border:1px solid #1e40af;width:13%;font-weight:700;">⏳ In Progress</th>
        <th style="padding:12px 12px;font-size:13px;color:#fca5a5;text-align:center;border:1px solid #1e40af;width:14%;font-weight:700;">⛔ Blocked</th>
      </tr>
    </thead>
    <tbody>${summaryRows}</tbody>
  </table>
</div>
<div style="padding:10px 16px 16px;">
  <div style="font-size:14px;font-weight:700;color:#1e3a5f;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;border-left:5px solid #dc2626;padding-left:10px;">Full Job Detail Log</div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;table-layout:fixed;">
    <colgroup>
      <col style="width:4%;"/>
      <col style="width:20%;"/>
      <col style="width:11%;"/>
      <col style="width:18%;"/>
      <col style="width:16%;"/>
      <col style="width:16%;"/>
      <col style="width:15%;"/>
    </colgroup>
    <thead>
      <tr style="background:linear-gradient(90deg,#1e3a5f,#1e40af);">
        <th style="padding:12px 8px;font-size:13px;color:#ffffff;text-align:center;border:1px solid #1e40af;font-weight:700;">ID</th>
        <th style="padding:12px 8px;font-size:13px;color:#ffffff;text-align:left;border:1px solid #1e40af;font-weight:700;">Job Name</th>
        <th style="padding:12px 8px;font-size:13px;color:#ffffff;text-align:left;border:1px solid #1e40af;font-weight:700;">Run ID</th>
        <th style="padding:12px 8px;font-size:13px;color:#ffffff;text-align:left;border:1px solid #1e40af;font-weight:700;">Status</th>
        <th style="padding:12px 8px;font-size:13px;color:#ffffff;text-align:left;border:1px solid #1e40af;font-weight:700;">Start Time</th>
        <th style="padding:12px 8px;font-size:13px;color:#ffffff;text-align:left;border:1px solid #1e40af;font-weight:700;">End Time</th>
        <th style="padding:12px 8px;font-size:13px;color:#ffffff;text-align:center;border:1px solid #1e40af;font-weight:700;">Runtime</th>
      </tr>
    </thead>
    <tbody>${detailRows}</tbody>
  </table>
</div>
<div style="background:#0f2027;padding:8px 16px;display:flex;justify-content:space-between;align-items:center;">
  <span style="font-size:7.5px;color:#64748b;">Auto-generated by UC4 Process Flow Automation &nbsp;|&nbsp; Woolworths Group</span>
  <span style="font-size:7.5px;color:#64748b;">Confidential &mdash; Internal Use Only</span>
</div>
</body>
</html>`;
    }

    // ─── EMAIL HTML BUILDERS ──────────────────────────────────────────────────

    /**
     * Wraps email body content in the standard header/footer shell.
     * Inherits the unified mathematical offset pattern to preserve subject synchronization.
     *
     * @param {string} alertBanner - HTML <tr> block for the coloured summary banner
     * @param {string} bodyContent - HTML for the main email body (tables, notes, etc.)
     * @returns {string} Complete HTML email document
     */
    _emailShell(alertBanner, bodyContent, isAlert = false) {
        return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width"/></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:32px 0;">
  <tr><td align="center">
  <table width="660" cellpadding="0" cellspacing="0" style="max-width:660px;width:100%;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.14);">

    <tr>
      <td style="background:${isAlert ? 'linear-gradient(135deg,#7f1d1d 0%,#dc2626 60%,#f97316 100%)' : 'linear-gradient(135deg,#4338ca 0%,#7c3aed 50%,#db2777 100%)'};padding:44px 40px;text-align:center;">
        <div style="font-size:11px;font-weight:600;color:#ffffff;text-transform:uppercase;letter-spacing:3.5px;margin-bottom:12px;">[NON-PROD] Automated Monitoring Report</div>
        <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;line-height:1.2;">NONPROD &mdash; UC4 Process Flow Automation</div>
      </td>
    </tr>

    ${alertBanner}

    <tr><td style="background:#ffffff;padding:32px 40px 24px;">${bodyContent}</td></tr>

    <tr>
      <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 40px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:10px;color:#94a3b8;">Automated by UC4 Process Flow Automation &nbsp;|&nbsp; NON-PROD Environment</td>
            <td align="right" style="font-size:10px;color:#94a3b8;">Woolworths Group &middot; Internal Use Only</td>
          </tr>
        </table>
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
    }

    /**
     * Builds the "Process Flow Summary" table used in both success and failure emails.
     */
    _summaryTable(aggregatedStats) {
        const fmtDate = (s) => {
            const result = this._fmtCsvDatetime(s);
            return (result && result !== 'N/A') ? result : '';
        };
        const ucColor = (raw) => {
            const u = (raw || '').toUpperCase();
            if (!u) return '#94a3b8';
            if (u.includes('ENDED_OK') && !u.includes('ENDED_NOT_OK')) return '#16a34a';
            if (u.includes('ENDED_CANCEL') || u.includes('ENDED_NOT_OK') || u.includes('ABORTED') || u.includes('FAULTED')) return '#dc2626';
            return '#d97706'; 
        };
        const rows = aggregatedStats.map((r, i) => {
            const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
            let statusBadge;
            if (r.FlowStatus === '✅ Completed') {
                statusBadge = `<span style="display:inline-block;background:#16a34a;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;letter-spacing:0.8px;">PASS</span>`;
            } else if (r.FlowStatus === '⛔ Blocked') {
                statusBadge = `<span style="display:inline-block;background:#dc2626;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;letter-spacing:0.8px;">FAIL</span>`;
            } else if (r.FlowStatus === '🚫 Not Triggered') {
                statusBadge = `<span style="display:inline-block;background:#d97706;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;letter-spacing:0.8px;">NOT TRIGGERED</span>`;
            } else if (r.FlowStatus === '🔵 Active') {
                statusBadge = `<span style="display:inline-block;background:#0369a1;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;letter-spacing:0.8px;">ACTIVE</span>`;
            } else if (r.FlowStatus === '⏳ In Progress') {
                statusBadge = `<span style="display:inline-block;background:#d97706;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;letter-spacing:0.8px;">RUNNING</span>`;
            } else {
                statusBadge = `<span style="display:inline-block;background:#64748b;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;letter-spacing:0.8px;">STALE</span>`;
            }
            const jobsDisplay = r.Total > 0 ? Number(r.Total).toLocaleString() : `<span style="color:#94a3b8;">—</span>`;
            const failDisplay = r.Blocked > 0 ? `<span style="color:#dc2626;font-weight:700;">${r.Blocked}</span>` : `<span style="color:#94a3b8;">0</span>`;
            return `
            <tr style="background:${bg};">
              <td style="padding:13px 16px;border-bottom:2px solid #f1f5f9;border-right:2px solid #f1f5f9;font-size:13px;font-weight:700;color:#1e293b;">
                ${r.JobName}
                ${r.NotTriggered && r.LastRanDate ? `<div style="font-size:11px;color:#92400e;margin-top:3px;font-weight:400;">${r.LastRanDate}</div>` : ''}
              </td>
              <td style="padding:13px 16px;border-bottom:2px solid #f1f5f9;border-right:2px solid #f1f5f9;font-size:13px;font-weight:500;color:#475569;text-align:center;">${jobsDisplay}</td>
              <td style="padding:13px 16px;border-bottom:2px solid #f1f5f9;border-right:2px solid #f1f5f9;font-size:13px;font-weight:500;text-align:center;">${failDisplay}</td>
              <td style="padding:10px 16px;border-bottom:2px solid #f1f5f9;border-right:2px solid #f1f5f9;font-size:12px;font-weight:500;vertical-align:top;min-width:140px;">
                ${fmtDate(r.activationTime) ? `<div style="font-weight:600;color:#1e293b;font-size:12px;">${fmtDate(r.activationTime)}</div>` : '<span style="color:#94a3b8;font-size:12px;">—</span>'}
                ${r.rawUC4Status ? `<div style="font-size:11px;margin-top:3px;color:${ucColor(r.rawUC4Status)};line-height:1.35;">${r.rawUC4Status}</div>` : ''}
              </td>
              <td style="padding:13px 16px;border-bottom:2px solid #f1f5f9;text-align:center;">${statusBadge}</td>
            </tr>`;
        }).join('');

        return `
        <div style="margin-bottom:28px;">
          <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:12px;">Process Flow Summary</div>
          <div style="border:2px solid #e2e8f0;border-radius:12px;overflow:hidden;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <thead>
              <tr style="background:#1e293b;">
                <th style="padding:12px 16px;font-size:11px;color:#ffffff;font-weight:700;text-align:left;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.15);">Process Flow Name</th>
                <th style="padding:12px 16px;font-size:11px;color:#94a3b8;font-weight:700;text-align:center;white-space:nowrap;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.15);">Jobs Processed</th>
                <th style="padding:12px 16px;font-size:11px;color:#f87171;font-weight:700;text-align:center;white-space:nowrap;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.15);">Failed Jobs</th>
                <th style="padding:12px 16px;font-size:11px;color:#94a3b8;font-weight:700;text-align:left;white-space:nowrap;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.15);">Activation Time</th>
                <th style="padding:12px 16px;font-size:11px;color:#ffffff;font-weight:700;text-align:center;white-space:nowrap;text-transform:uppercase;letter-spacing:0.8px;">Execution Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          </div>
        </div>`;
    }

    /**
     * Builds the failure details section for PDF generation (retained for PDFs).
     */
    _blockedTable(records) {
        if (!records || records.length === 0) return '';

        const notTriggered = records.filter(r => (r.Status || '').toUpperCase() === 'NOT_TRIGGERED');
        const actualFails  = records.filter(r => (r.Status || '').toUpperCase() !== 'NOT_TRIGGERED');
        let html = '';

        if (notTriggered.length > 0) {
            const ntRows = notTriggered.map((r, i) => {
                const bg = i % 2 === 0 ? '#fffbeb' : '#fef9ee';
                const lastRan = r.ObjectName && r.ObjectName !== 'N/A' ? r.ObjectName : 'Unknown';
                return `
                <tr style="background:${bg};">
                  <td style="padding:12px 14px;border-bottom:2px solid #fde68a;border-right:2px solid #fde68a;font-size:13px;font-weight:700;color:#1e293b;">${r.JobName || 'N/A'}</td>
                  <td style="padding:12px 14px;border-bottom:2px solid #fde68a;border-right:2px solid #fde68a;font-size:13px;color:#92400e;font-weight:600;">${lastRan}</td>
                  <td style="padding:12px 14px;border-bottom:2px solid #fde68a;text-align:center;">
                    <span style="background:#d97706;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;white-space:nowrap;">NOT TRIGGERED</span>
                  </td>
                </tr>`;
            }).join('');
            html += `
            <div style="margin-bottom:24px;">
              <div style="font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:12px;">&#9888; Flows Not Triggered in Overnight Batch</div>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:2px solid #fde68a;border-radius:12px;overflow:hidden;">
                <thead>
                  <tr style="background:linear-gradient(90deg,#78350f,#d97706);">
                    <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.25);">Process Flow</th>
                    <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.25);">Last Run Detected</th>
                    <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:center;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;">Status</th>
                  </tr>
                </thead>
                <tbody>${ntRows}</tbody>
              </table>
            </div>`;
        }

        if (actualFails.length > 0) {
            const rows = actualFails.map((r, i) => {
                const bg = i % 2 === 0 ? '#fff5f5' : '#fff8f8';
                const statusText = (r.Status || r.FinalStatus || 'N/A').replace(/ - .*/,'').trim();
                return `
                <tr style="background:${bg};">
                  <td style="padding:12px 14px;border-bottom:2px solid #fee2e2;border-right:2px solid #fee2e2;font-size:13px;font-weight:700;color:#1e293b;">${r.JobName || 'N/A'}</td>
                  <td style="padding:12px 14px;border-bottom:2px solid #fee2e2;border-right:2px solid #fee2e2;font-size:12px;font-family:monospace;font-weight:700;color:#1e293b;">${r.ObjectName || 'N/A'}</td>
                  <td style="padding:12px 14px;border-bottom:2px solid #fee2e2;">
                    <span style="background:#dc2626;color:#fff;border-radius:30px;padding:5px 18px;font-size:11px;font-weight:700;white-space:nowrap;">${statusText}</span>
                  </td>
                </tr>`;
            }).join('');
            html += `
            <div style="margin-bottom:16px;">
              <div style="font-size:14px;font-weight:800;color:#7f1d1d;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:12px;">&#x26D4; Blocked &amp; Failed Job Details</div>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:2px solid #fee2e2;border-radius:12px;overflow:hidden;">
                <thead>
                  <tr style="background:linear-gradient(90deg,#7f1d1d,#dc2626);">
                    <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.25);">Process Flow</th>
                    <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.25);">Job Name</th>
                    <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;">Status</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`;
        }

        return html;
    }

    // ─── EMAIL SENDERS ───────────────────────────────────────────────────────

    /**
     * Sends the "All Clear" email when no failures or slow jobs were found.
     * Incorporates the synchronized mathematical offset subject time matching the dmailer structure.
     *
     * @param {Array} aggregatedStats - Output from aggregateJobStats()
     */
    async sendSuccessEmail(aggregatedStats) {
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: this.emailAuth });
        const _subjectDate = this._getDmailerSubjectTimestamp();

        const _totalFlows        = aggregatedStats.length;
        const _completedFlows    = aggregatedStats.filter(r => r.FlowStatus === '✅ Completed').length;
        const _activeFlows       = aggregatedStats.filter(r => r.FlowStatus === '🔵 Active').length;
        const _inProgressFlows   = aggregatedStats.filter(r => r.FlowStatus === '⏳ In Progress').length;
        const _notTriggeredFlows = aggregatedStats.filter(r => r.FlowStatus === '🚫 Not Triggered').length;
        const _stillRunning      = _activeFlows + _inProgressFlows;

        const alertBanner = `
        <tr>
          <td style="background:#1e293b;padding:28px 40px;border-top:4px solid #22c55e;">
            <div style="font-size:10px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:2px;margin-bottom:20px;">Run Summary</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
              <tr>
                <td width="25%" style="padding-right:6px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;">
                    <div style="font-size:40px;font-weight:800;color:#e2e8f0;line-height:1;">${_totalFlows}</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Total Flows</div>
                  </div>
                </td>
                <td width="25%" style="padding:0 3px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;border-bottom:3px solid #22c55e;">
                    <div style="font-size:40px;font-weight:800;color:#22c55e;line-height:1;">${_completedFlows}</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Completed</div>
                  </div>
                </td>
                <td width="25%" style="padding:0 3px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;border-bottom:3px solid #3b82f6;">
                    <div style="font-size:40px;font-weight:800;color:#3b82f6;line-height:1;">${_stillRunning}</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Still Active</div>
                  </div>
                </td>
                <td width="25%" style="padding-left:6px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;">
                    <div style="font-size:40px;font-weight:800;color:#475569;line-height:1;">0</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Blocked</div>
                  </div>
                </td>
              </tr>
            </table>
            <div style="border-top:1px solid #334155;padding-top:16px;">
              <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td style="font-size:12px;color:#ffffff;padding:3px 28px 3px 0;white-space:nowrap;font-weight:500;">Execution Start Time</td>
                  <td style="font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;padding:3px 0;">:&nbsp;&nbsp;${this.suiteStartFormatted || '&mdash;'}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:#ffffff;padding:3px 28px 3px 0;white-space:nowrap;font-weight:500;">Execution End Time</td>
                  <td style="font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;padding:3px 0;">:&nbsp;&nbsp;${this.suiteEndFormatted || '&mdash;'}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:#ffffff;padding:3px 28px 3px 0;white-space:nowrap;font-weight:500;">Duration</td>
                  <td style="font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;padding:3px 0;">:&nbsp;&nbsp;${this.totalDuration || '&mdash;'}</td>
                </tr>
              </table>
            </div>
            ${_notTriggeredFlows > 0 ? `<div style="font-size:11px;color:#fbbf24;margin-top:14px;font-weight:500;">${_notTriggeredFlows} process flow(s) did not execute in the overnight batch — investigate UC4 scheduling.</div>` : '<div style="font-size:11px;color:#ffffff;margin-top:14px;">This report summarises the scheduled UC4 overnight batch run. No failures detected — all active process flows completed successfully.</div>'}
          </td>
        </tr>`;

        const body = `
        ${this._summaryTable(aggregatedStats)}
        <p style="font-size:11px;color:#94a3b8;margin-top:4px;border-top:1px solid #f1f5f9;padding-top:16px;">
            The full job detail report (PDF) is attached for your records. No further action is required.
        </p>`;

        const attachments = [];
        if (fsSync.existsSync(this.allJobsPdfPath)) {
            attachments.push({ filename: 'ProcessFlowRunStatus.pdf', path: this.allJobsPdfPath });
        }

        const mailOptions = {
            from:    this.emailAuth.user,
            to:      `${this.emailRecipient}`,
            subject: `[NON-PROD] UC4 Process Flow Automation \u2014 ${_subjectDate} | \u2705 ALL CLEAR`,
            html:    this._emailShell(alertBanner, body, false),
            attachments,
        };

        try {
            console.log(`Sending success notification email to: ${this.emailRecipient}`);
            await transporter.sendMail(mailOptions);
            console.log('Success email sent successfully!');
        } catch (error) {
            console.error('Error sending success email:', error.message);
        }
    }

    /**
     * Sends the failure/slow-jobs alert email.
     * Blocked/Failed Job details table is excluded from the email body (retained in attached PDFs).
     *
     * @param {Array} failedJobRecords - Rows from the failed-jobs CSV
     * @param {Array} aggregatedStats  - Output from aggregateJobStats()
     * @param {Array} [slowJobs=[]]    - Filtered slow-job records from _getSlowJobs()
     */
    async sendFailureEmail(failedJobRecords, aggregatedStats, slowJobs = []) {
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: this.emailAuth });
        const _subjectDate = this._getDmailerSubjectTimestamp();

        const _totalFlows         = aggregatedStats.length;
        const _completedFlows     = aggregatedStats.filter(r => r.FlowStatus === '✅ Completed').length;
        const _activeFlows        = aggregatedStats.filter(r => r.FlowStatus === '🔵 Active').length;
        const _inProgressFlows    = aggregatedStats.filter(r => r.FlowStatus === '⏳ In Progress').length;
        const _blockedFlows       = aggregatedStats.filter(r => r.FlowStatus === '⛔ Blocked').length;
        const _notTriggeredFlows  = aggregatedStats.filter(r => r.FlowStatus === '🚫 Not Triggered').length;
        const _stillRunning       = _activeFlows + _inProgressFlows;

        const alertBanner = `
        <tr>
          <td style="background:#1e293b;padding:28px 40px;border-top:4px solid #dc2626;">
            <div style="font-size:10px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:2px;margin-bottom:20px;">Run Summary</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
              <tr>
                <td width="25%" style="padding-right:6px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;">
                    <div style="font-size:40px;font-weight:800;color:#e2e8f0;line-height:1;">${_totalFlows}</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Total Flows</div>
                  </div>
                </td>
                <td width="25%" style="padding:0 3px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;border-bottom:3px solid #22c55e;">
                    <div style="font-size:40px;font-weight:800;color:#22c55e;line-height:1;">${_completedFlows}</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Completed</div>
                  </div>
                </td>
                <td width="25%" style="padding:0 3px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;border-bottom:3px solid #3b82f6;">
                    <div style="font-size:40px;font-weight:800;color:#3b82f6;line-height:1;">${_stillRunning}</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Still Active</div>
                  </div>
                </td>
                <td width="25%" style="padding-left:6px;">
                  <div style="background:#0f172a;border-radius:8px;padding:20px 10px;text-align:center;border-bottom:3px solid #ef4444;">
                    <div style="font-size:40px;font-weight:800;color:#ef4444;line-height:1;">${_blockedFlows}</div>
                    <div style="font-size:9px;color:#ffffff;text-transform:uppercase;letter-spacing:1.2px;margin-top:8px;font-weight:700;">Blocked</div>
                  </div>
                </td>
              </tr>
            </table>
            <div style="border-top:1px solid #334155;padding-top:16px;">
              <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td style="font-size:12px;color:#ffffff;padding:3px 28px 3px 0;white-space:nowrap;font-weight:500;">Execution Start Time</td>
                  <td style="font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;padding:3px 0;">:&nbsp;&nbsp;${this.suiteStartFormatted || '&mdash;'}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:#ffffff;padding:3px 28px 3px 0;white-space:nowrap;font-weight:500;">Execution End Time</td>
                  <td style="font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;padding:3px 0;">:&nbsp;&nbsp;${this.suiteEndFormatted || '&mdash;'}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:#ffffff;padding:3px 28px 3px 0;white-space:nowrap;font-weight:500;">Duration</td>
                  <td style="font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;padding:3px 0;">:&nbsp;&nbsp;${this.totalDuration || '&mdash;'}</td>
                </tr>
              </table>
            </div>
            ${_notTriggeredFlows > 0 ? `<div style="font-size:11px;color:#fbbf24;margin-top:14px;font-weight:500;">${_notTriggeredFlows} process flow(s) did not execute in the overnight batch — investigate UC4 scheduling.</div>` : '<div style="font-size:11px;color:#ffffff;margin-top:14px;">This report summarises the scheduled UC4 overnight batch run. Immediate action may be required.</div>'}
          </td>
        </tr>`;

        // Blocked & Failed job table removed from the email body as requested
        const body = `
        ${this._summaryTable(aggregatedStats)}
        ${this._slowJobsTable(slowJobs)}
        <p style="font-size:11px;color:#94a3b8;margin-top:4px;border-top:1px solid #f1f5f9;padding-top:16px;">
            Please refer to the attached PDF reports (ProcessFlowRunStatus.pdf / FailureList.pdf) for complete task details and failure logs.
        </p>
        `;

        const attachments = [];
        if (fsSync.existsSync(this.allJobsPdfPath)) {
            attachments.push({ filename: 'ProcessFlowRunStatus.pdf', path: this.allJobsPdfPath });
        }
        if (fsSync.existsSync(this.failureListPdfPath)) {
            attachments.push({ filename: 'FailureList.pdf', path: this.failureListPdfPath });
        }

        const subjectSuffix = failedJobRecords.length > 0 && slowJobs.length > 0
            ? '\u274C FAILURES & PERFORMANCE ANOMALIES DETECTED'
            : failedJobRecords.length > 0
            ? '\u274C FAILURES DETECTED'
            : '\u26A0\uFE0F PERFORMANCE ANOMALIES \u2014 EXCEEDED 30-MIN RUNTIME';
        
        const mailOptions = {
            from:    this.emailAuth.user,
            to:      `${this.emailRecipient}`,
            subject: `[NON-PROD] UC4 Process Flow Automation \u2014 ${_subjectDate} | ${subjectSuffix}`,
            html:    this._emailShell(alertBanner, body, true),
            attachments,
        };

        try {
            console.log(`Sending failure notification email to: ${this.emailRecipient}`);
            await transporter.sendMail(mailOptions);
            console.log('Failure email sent successfully!');
        } catch (error) {
            console.error('Error sending failure email:', error.message);
        }
    }

    // ─── RUNTIME HELPERS ──────────────────────────────────────────────────────

    /**
     * Parses a UC4 runtime string ('H:MM:SS') into total minutes.
     *
     * @param {string} rt - e.g. '1:35:42' (1 hour 35 min 42 sec → 95 minutes)
     * @returns {number} Total minutes
     */
    _parseRuntimeMins(rt) {
        if (!rt || rt === 'N/A') return 0;
        const m = rt.match(/^(\d+):(\d{2}):\d{2}$/);
        if (!m) return 0;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }

    /**
     * Returns all job records whose runtime is 30 minutes or longer.
     *
     * @param {Array} allJobRecords - All rows from all_jobs_log.csv
     * @returns {Array}
     */
    _getSlowJobs(allJobRecords) {
        return allJobRecords.filter(r => this._parseRuntimeMins(r.Runtime) >= 30);
    }

    // ─── FAILURE LIST PDF ──────────────────────────────────────────────────────

    /**
     * Generates FailureList.pdf — a focused two-section report.
     */
    async generateFailureListPdf(failedJobRecords, slowJobs, aggregatedStats = []) {
        try {
            const { chromium } = require('@playwright/test');
            const html    = this.buildFailureListPdfHtml(failedJobRecords, slowJobs, aggregatedStats);
            const browser = await chromium.launch({ headless: true });
            const page    = await browser.newPage();
            await page.setContent(html, { waitUntil: 'networkidle' });
            await page.pdf({
                path:            this.failureListPdfPath,
                format:          'A4',
                landscape:       true,
                printBackground: true,
                margin:          { top: '12mm', bottom: '12mm', left: '8mm', right: '8mm' },
            });
            await browser.close();
            console.log(`Failure List PDF generated: ${this.failureListPdfPath}`);
        } catch (err) {
            console.warn(`Failure List PDF generation failed (non-fatal): ${err.message}`);
        }
    }

    /**
     * Builds the HTML string rendered into FailureList.pdf.
     */
    buildFailureListPdfHtml(failedJobRecords, slowJobs, aggregatedStats = []) {
        const runDate  = this._formatDateTime(Date.now());
        const safeText = (v) => (v || 'N/A').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const fmtDt    = (v) => this._fmtCsvDatetime(v);
        const actTimeMap = {};
        for (const s of aggregatedStats) { actTimeMap[String(s.JobID)] = s.activationTime || ''; }
        const fmtActTime = (jobId) => {
            const raw = actTimeMap[String(jobId)];
            return raw ? this._fmtCsvDatetime(raw) : '—';
        };

        const actualFailures = failedJobRecords.filter(r => (r.Status || '').toUpperCase() !== 'NOT_TRIGGERED');
        const failureCount   = actualFailures.length;
        const slowCount      = slowJobs.length;

        const failureRows = actualFailures.map((r, i) => {
            const bg    = i % 2 === 0 ? '#fff5f5' : '#fff0f0';
            const label = (r.Status || 'N/A').replace(/ - .*/, '').trim();
            return `
            <tr style="background:${bg};">
                <td style="padding:8px 9px;border:1px solid #fecaca;font-size:12.5px;font-weight:700;color:#111827;word-wrap:break-word;">${safeText(r.JobName)}</td>
                <td style="padding:8px 9px;border:1px solid #fecaca;font-size:11.5px;font-family:monospace;word-break:break-all;">${safeText(r.ObjectName)}</td>
                <td style="padding:8px 9px;border:1px solid #fecaca;">
                    <span style="display:inline-block;padding:4px 9px;border-radius:5px;background:#dc2626;color:#ffffff;font-weight:700;font-size:11px;">${label}</span>
                </td>
                <td style="padding:8px 9px;border:1px solid #fecaca;font-size:11.5px;color:#374151;word-wrap:break-word;overflow-wrap:break-word;">${safeText(fmtActTime(r.JobID))}</td>
                <td style="padding:8px 9px;border:1px solid #fecaca;font-size:11.5px;white-space:nowrap;">${fmtDt(r.StartTime)}</td>
                <td style="padding:8px 9px;border:1px solid #fecaca;font-size:11.5px;white-space:nowrap;">${fmtDt(r.EndTime)}</td>
                <td style="padding:8px 9px;border:1px solid #fecaca;font-size:12.5px;text-align:center;background:#ef4444;color:#ffffff;font-weight:700;">${safeText(r.Runtime)}</td>
            </tr>`;
        }).join('') || `<tr><td colspan="7" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No failed jobs detected</td></tr>`;

        const slowRows = slowJobs.map((r, i) => {
            const bg   = i % 2 === 0 ? '#fffbeb' : '#fef9ee';
            const u    = (r.Status || '').toUpperCase();
            let statusBg = '#dcfce7', statusColor = '#15803d';
            if (u.includes('ENDED_NOT_OK') || u.includes('ABORTED') || u.includes('FAULTED') || u.includes('ENDED_CANCEL')) {
                statusBg = '#fee2e2'; statusColor = '#b91c1c';
            } else if (u.includes('ENDED_INACTIVE')) {
                statusBg = '#dbeafe'; statusColor = '#1d4ed8';
            }
            const statusLabel = (r.Status || 'N/A').replace(/ - .*/, '').trim();
            return `
            <tr style="background:${bg};">
                <td style="padding:8px 9px;border:1px solid #fde68a;font-size:12.5px;font-weight:700;color:#111827;word-wrap:break-word;">${safeText(r.JobName)}</td>
                <td style="padding:8px 9px;border:1px solid #fde68a;font-size:11.5px;font-family:monospace;word-break:break-all;">${safeText(r.ObjectName)}</td>
                <td style="padding:8px 9px;border:1px solid #fde68a;">
                    <span style="display:inline-block;padding:4px 9px;border-radius:5px;background:${statusBg};color:${statusColor};font-weight:700;font-size:11px;">${statusLabel}</span>
                </td>
                <td style="padding:8px 9px;border:1px solid #fde68a;font-size:11.5px;color:#374151;word-wrap:break-word;overflow-wrap:break-word;">${safeText(fmtActTime(r.JobID))}</td>
                <td style="padding:8px 9px;border:1px solid #fde68a;font-size:11.5px;white-space:nowrap;">${fmtDt(r.StartTime)}</td>
                <td style="padding:8px 9px;border:1px solid #fde68a;font-size:11.5px;white-space:nowrap;">${fmtDt(r.EndTime)}</td>
                <td style="padding:8px 9px;border:1px solid #fde68a;font-size:12.5px;text-align:center;background:#f59e0b;color:#ffffff;font-weight:700;">${safeText(r.Runtime)}</td>
            </tr>`;
        }).join('') || `<tr><td colspan="7" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No slow jobs detected (&ge;30 min)</td></tr>`;

        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><style>* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; font-size: 13px; background: #f1f5f9; color: #1e293b; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
</style></head>
<body>
<div style="background:linear-gradient(135deg,#7f1d1d 0%,#dc2626 60%,#f59e0b 100%);padding:14px 20px;display:flex;justify-content:space-between;align-items:center;">
  <div>
    <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:0.5px;">NONPROD &mdash; UC4 Process Flow Automation &mdash; Failure List</div>
    <div style="font-size:12px;colorrgba(255,255,255,0.85);margin-top:4px;">Generated: ${runDate} &nbsp;|&nbsp; Performance threshold: 30 minutes</div>
  </div>
  <div style="text-align:right;">
    <div style="font-size:12px;colorrgba(255,255,255,0.9);">Failed Jobs: <b style="color:#fff;">${failureCount}</b></div>
    <div style="font-size:12px;colorrgba(255,255,255,0.9);">Slow Jobs (&ge;30 min): <b style="color:#fff;">${slowCount}</b></div>
  </div>
</div>
<div style="padding:12px 16px 6px;">
  <div style="font-size:14px;font-weight:700;color:#dc2626;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;border-left:5px solid #dc2626;padding-left:10px;">⛔ Failed Jobs</div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #fecaca;table-layout:fixed;">
    <colgroup>
      <col style="width:15%;"/><col style="width:14%;"/><col style="width:13%;"/>
      <col style="width:16%;"/><col style="width:16%;"/><col style="width:18%;"/><col style="width:8%;"/>
    </colgroup>
    <thead>
      <tr style="background:linear-gradient(90deg,#7f1d1d,#dc2626);">
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #b91c1c;font-weight:700;">Process Flow</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #b91c1c;font-weight:700;">Job Name</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #b91c1c;font-weight:700;">Status</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #b91c1c;font-weight:700;">Activation Time</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #b91c1c;font-weight:700;">Start Time</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #b91c1c;font-weight:700;">End Time</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:center;border:1px solid #b91c1c;font-weight:700;">Runtime</th>
      </tr>
    </thead>
    <tbody>${failureRows}</tbody>
  </table>
</div>
<div style="padding:12px 16px 16px;">
  <div style="font-size:14px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;border-left:5px solid #f59e0b;padding-left:10px;">⏱ Performance Anomalies — Exceeded 30-Minute Runtime</div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #fde68a;table-layout:fixed;">
    <colgroup>
      <col style="width:15%;"/><col style="width:14%;"/><col style="width:13%;"/>
      <col style="width:16%;"/><col style="width:16%;"/><col style="width:18%;"/><col style="width:8%;"/>
    </colgroup>
    <thead>
      <tr style="background:linear-gradient(90deg,#78350f,#f59e0b);">
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #d97706;font-weight:700;">Process Flow</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #d97706;font-weight:700;">Job Name</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #d97706;font-weight:700;">Status</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #d97706;font-weight:700;">Activation Time</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #d97706;font-weight:700;">Start Time</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:left;border:1px solid #d97706;font-weight:700;">End Time</th>
        <th style="padding:9px 8px;font-size:12px;color:#ffffff;text-align:center;border:1px solid #d97706;font-weight:700;">Runtime</th>
      </tr>
    </thead>
    <tbody>${slowRows}</tbody>
  </table>
</div>
<div style="background:#0f2027;padding:8px 16px;display:flex;justify-content:space-between;align-items:center;">
  <span style="font-size:7.5px;color:#64748b;">Auto-generated by UC4 Process Flow Automation &nbsp;|&nbsp; Woolworths Group &nbsp;|&nbsp; Performance threshold: 30 minutes</span>
  <span style="font-size:7.5px;color:#64748b;">Confidential &mdash; Internal Use Only</span>
</div>
</body></html>`;
    }

    /**
     * Builds the "Performance Risk" slow-jobs section for failure emails.
     */
    _slowJobsTable(slowJobs) {
        if (!slowJobs || slowJobs.length === 0) return '';
        const cellBorder = 'border-bottom:2px solid #fde68a;border-right:2px solid #fde68a;';
        const rows = slowJobs.map((r, i) => {
            const bg     = i % 2 === 0 ? '#fffbeb' : '#fef9ee';
            const rawEnd = r.EndTime || r.endTime || '';
            const endTime = rawEnd ? this._fmtCsvDatetime(rawEnd) : '&mdash;';
            return `
            <tr style="background:${bg};">
              <td style="padding:12px 14px;${cellBorder}font-size:13px;font-weight:700;color:#1e293b;">${r.JobName || 'N/A'}</td>
              <td style="padding:12px 14px;${cellBorder}font-size:12px;font-family:monospace;font-weight:700;color:#1e293b;">${r.ObjectName || 'N/A'}</td>
              <td style="padding:12px 14px;${cellBorder}font-size:12px;font-weight:500;color:#374151;white-space:nowrap;">${endTime}</td>
              <td style="padding:12px 14px;border-bottom:2px solid #fde68a;font-size:12px;text-align:center;">
                <span style="background:#f59e0b;color:#fff;border-radius:4px;padding:5px 14px;font-weight:700;font-size:12px;">${r.Runtime}</span>
              </td>
            </tr>`;
        }).join('');
        return `
        <div style="margin-bottom:16px;">
          <div style="font-size:14px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:12px;">&#9203; Performance Anomalies &mdash; Exceeded 30-Minute Runtime</div>
          <div style="font-size:11px;color:#92400e;margin-bottom:10px;">The following completed batch jobs exceeded the 30-minute runtime threshold during the overnight run. These are historical records &mdash; no jobs are currently active.</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:3px solid #d97706;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px #fde68a;">
            <thead>
              <tr style="background:linear-gradient(90deg,#78350f,#d97706);">
                <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.25);">Process Flow</th>
                <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.25);">Job Name</th>
                <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;border-right:1px solid rgba(255,255,255,0.25);">Completed At (AEST)</th>
                <th style="padding:11px 14px;font-size:11px;color:#fff;text-align:center;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;">Runtime</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }
}

module.exports = LogFetcher;