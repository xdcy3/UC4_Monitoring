/**
 * UC4jobpage.js Page Object for UC4 AWI Job / Process Flow Inspection
 */
class JobPage {
    /**
     * @param {import('@playwright/test').Page} page
     * @param {import('@playwright/test').Expect} expect
     */
    constructor(page, expect) {
        this.page   = page;
        this.expect = expect;

        // Toolbar / search locators
        this.searchField      = page.locator('#global-search-field').getByRole('textbox', { name: 'Search' });
        this.jobLink          = (jobDetail) => page.locator('a').filter({ hasText: jobDetail }).first();
        this.executionsButton = page.getByRole('button', { name: 'Executions' }); 
        this.detailsButton    = page.locator('button:has-text("Details"), [title="Details"], [data-role="details-button"]').first();
        this.layOutButton     = page.locator('button:has(ecc-icon[src="@theme/imgs/icons/vector/hierarchical_view.svg"])');
        this.firstExecutionRow = this.page.locator('tbody > tr').first();

        this.restartedRunIds      = new Set();
        this.todayRunActive       = false;
        this._diagnosticDone      = false;
        this._panelDiagnosticDone = false;
    }

    /**
     * Main entry point for processing a single process flow.
     */
    async searchJob(jobName, jobDetail) {
        try {
            if (this.page.isClosed()) {
                throw new Error('Page is closed. Cannot perform job search.');
            }

            this.todayRunActive = false;
            console.log(`Searching for Processflow: ${jobName}`);

            await this.searchField.waitFor({ state: 'visible', timeout: 15000 });
            await this.searchField.click();
            await this.searchField.fill('');
            await this.searchField.fill(jobName);

            const jobLinkSelector   = `a:has-text("${jobDetail}")`;
            const noResultsSelector = 'ecc-listitem-list:has-text("No results found No results found Objects")';

            console.log(`Waiting for job link with detail: ${jobDetail} or 'No results found' message...`);

            await Promise.race([
                this.page.waitForSelector(jobLinkSelector,   { timeout: 12000 }),
                this.page.waitForSelector(noResultsSelector, { timeout: 12000 })
            ]);

            const jobLink = this.jobLink(jobDetail);
            if (await jobLink.isVisible()) {
                await jobLink.click();
            } else if (await this.page.locator(noResultsSelector).isVisible()) {
                throw new Error(`No results found for JobName: ${jobName}, JobDetail: ${jobDetail}`);
            } else {
                throw new Error(`Neither job link nor 'No results found' message appeared for JobName: ${jobName}, JobDetail: ${jobDetail}`);
            }

            console.log('Waiting for Executions button...');
            await this.page.waitForSelector('button:has-text("Executions")', { timeout: 12000 });
            await this.executionsButton.click();
            
            console.log('Clicked Executions. Waiting for the execution list to be ready...');
            
            // ─── SAFETY TIMEOUT MONITOR FOR EMPTY OR UNMOUNTED HISTORIES ───
            const firstRow = this.page.locator('tbody > tr').first();
            const emptyGridMessage = this.page.locator('ecc-empty-panel, .v-table-body-empty, :text("No executions found")').first();

            try {
                await Promise.race([
                    firstRow.waitFor({ state: 'attached', timeout: 20000 }),
                    emptyGridMessage.waitFor({ state: 'visible', timeout: 20000 })
                ]);
            } catch (timeoutErr) {
                throw new Error(`Execution table loading failed or session dropped completely after 20s.`);
            }

            if (await emptyGridMessage.isVisible()) {
                console.warn(`[Warning] No execution history records exist for Processflow: ${jobName}`);
                return { parentStatus: 'NO_EXECUTIONS', jobs: [] };
            }

            console.log('Execution list is ready.');
            
            // ─── DETERMINISTIC CHRONOLOGICAL LOCK ───────────────────────────
            this.firstExecutionRow = await this._findTargetExecutionRow();
            await this.expect(this.firstExecutionRow).toBeVisible({ timeout: 15000 });
            // ───────────────────────────────────────────────────────────────────

            let parentFlowStatus = '';
            let rawUC4Status      = '';  
            let activationTimeStr = '';  
            try {
                const rowText = (await this.firstExecutionRow.textContent() || '').trim();
                const statusMatch = rowText.match(
                    /\b(ENDED_OK|ENDED_NOT_OK|ENDED_CANCEL|ENDED_INACTIVE|RUNNING|ACTIVE|BLOCKED|ABORTED|FAULTED|WAITING_FOR_EXTERNAL)\b/i
                );
                parentFlowStatus = statusMatch ? statusMatch[1].toUpperCase() : '';
                console.log(`[ParentFlowStatus] ${jobDetail}: "${parentFlowStatus}"`);

                // ── 1. DYNAMIC HEADER COLUMN LOOKUP FOR "ACTIVATION TIME" ──
                const activationColIndex = await this.page.evaluate(() => {
                    const headers = Array.from(document.querySelectorAll('th, div.v-table-header-cell, td.v-table-header-cell'));
                    for (let i = 0; i < headers.length; i++) {
                        const headerText = (headers[i].innerText || headers[i].textContent || '').trim();
                        if (/activation\s*time/i.test(headerText)) {
                            return i;
                        }
                    }
                    return -1;
                });

                // ── 2. EXTRACT CELL AT THE IDENTIFIED COLUMN INDEX ──
                const rawCellText = await this.firstExecutionRow.evaluate((tr, colIdx) => {
                    const tds = Array.from(tr.querySelectorAll('td'));
                    if (colIdx !== -1 && tds[colIdx]) {
                        return (tds[colIdx].innerText || tds[colIdx].textContent || '').replace(/\s+/g, ' ').trim();
                    }
                    // Secondary safety scan across tds if header search returned -1
                    for (const td of tds) {
                        const txt = (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
                        if (/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.test(txt)) return txt;
                    }
                    return '';
                }, activationColIndex);

                // ── 3. PARSE & NORMALIZE DATE WITH TIME TO DD/MM/YYYY FORMAT ──
                if (rawCellText) {
                    const dateRe = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/;
                    const match = rawCellText.match(dateRe);
                    if (match) {
                        let pA = parseInt(match[1], 10);
                        let pB = parseInt(match[2], 10);
                        let day = pA > 12 ? pA : pB;
                        let month = pA > 12 ? pB : pA;

                        const datePart = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${match[3]}`;
                        const remainingText = rawCellText.replace(match[0], '').trim();

                        activationTimeStr = remainingText ? `${datePart} ${remainingText}` : datePart;
                    } else {
                        activationTimeStr = rawCellText;
                    }
                }

                // Extract status phrase
                const cells = await this.firstExecutionRow.evaluate(tr =>
                    Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim())
                );
                const statusPhraseRe = /Waiting for end of parallel|Workflow is blocked|ENDED_|Active|Running|ABORTED|FAULTED/i;
                for (let i = 3; i < Math.min(cells.length, 10); i++) {
                    if (statusPhraseRe.test(cells[i])) { rawUC4Status = cells[i]; break; }
                }
            } catch (e) {
                console.warn(`[ParentFlowStatus] Could not read parent row: ${e.message}`);
            }

            // TARGET LOCK FIX: Focus click directly into visible table data cells to prevent container exceptions
            const targetCell = this.firstExecutionRow.locator('td').first();
            await targetCell.waitFor({ state: 'visible', timeout: 5000 });
            await targetCell.dblclick({ force: true });
            console.log('Double-clicked on the target execution row cell.');

            // ── LAYER 2 GUARD: IF GRID WAS BLANK, READ FROM DETAILS PANEL ──
            if (!activationTimeStr) {
                console.log('[Activation Fallback] Grid cell empty. Fetching from details side-panel...');
                await this.openDetailsPanel();
                const panelDetails = await this.readDetailsFromPanel();
                if (panelDetails && panelDetails.activationTime && panelDetails.activationTime !== 'N/A') {
                    activationTimeStr = panelDetails.activationTime;
                    console.log(`[Activation Fallback] Restored from side-panel: "${activationTimeStr}"`);
                }
            }

            console.log(`[RowCapture] ${jobDetail}: uc4Status="${rawUC4Status}" | actTime="${activationTimeStr}"`);

            console.log('Waiting for the layOutButton...');
            await this.layOutButton.waitFor({ state: 'visible', timeout: 15000 });
            await this.layOutButton.click();
            console.log('Clicked the layOutButton.');
            
            await this.openDetailsPanel();
            const allStats = await this.clickAndExtractFromTableRows(jobDetail);
            
            const metaTags = [];
            if (this.todayRunActive) metaTags.push('TODAY_ACTIVE');
            if (rawUC4Status)        metaTags.push(`RAW:${rawUC4Status}`);
            if (activationTimeStr)   metaTags.push(`ACT:${activationTimeStr}`);
            const finalParentStatus = metaTags.length
                ? `${parentFlowStatus}|${metaTags.join('|')}`
                : parentFlowStatus;
            return { parentStatus: finalParentStatus, jobs: allStats };

        } catch (error) {
            console.error(`Error during job search for JobName: ${jobName}, JobDetail: ${jobDetail}`, error.message);
            throw error;
        }
    }

    /**
     * Deterministically identifies and targets yesterday's operational execution record.
     * Adaptive parser handles both DD/MM/YYYY and MM/DD/YYYY formats dynamically.
     */
    async _findTargetExecutionRow() {
        const now          = new Date();
        const aestOffsetMs = 10 * 60 * 60 * 1000;
        const nowAEST      = new Date(now.getTime() + aestOffsetMs);
        const targetAEST   = new Date(nowAEST.getTime() - 24 * 60 * 60 * 1000);
        
        const targetDay   = targetAEST.getUTCDate();
        const targetMonth = targetAEST.getUTCMonth() + 1;
        const targetYear  = targetAEST.getUTCFullYear();

        console.log(`[Target Lock] Target operational window matches: ${String(targetDay).padStart(2, '0')}/${String(targetMonth).padStart(2, '0')}/${targetYear}`);
        const allRows = this.page.locator('tbody > tr');

        // Helper function to convert raw UC4 text layouts safely into a true comparative timestamp number
        const extractTimestamp = (rowText) => {
            const dateTimeRegex = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i;
            const match = rowText.match(dateTimeRegex);
            if (!match) return null;

            let partA = parseInt(match[1], 10);
            let partB = parseInt(match[2], 10);
            const year  = parseInt(match[3], 10);

            let day, month;
            if (partA > 12) {
                day = partA;
                month = partB - 1;
            } else if (partB > 12) {
                day = partB;
                month = partA - 1;
            } else {
                day = partA;
                month = partB - 1;
            }

            let hours = parseInt(match[4], 10);
            const minutes = parseInt(match[5], 10);
            const ampm = match[6].toLowerCase();

            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;

            const parsedDate = new Date(year, month, day, hours, minutes);
            return {
                timestamp: parsedDate.getTime(),
                day: day,
                month: month + 1,
                year: year,
                text: `${String(day).padStart(2, '0')}/${String(month + 1).padStart(2, '0')}/${year}`
            };
        };

        // 1. Evaluate table sorting layout orientation via absolute numerical epochs
        const row0Text = await allRows.nth(0).textContent().catch(() => '') || '';
        const row1Text = await allRows.nth(1).textContent().catch(() => '') || '';
        
        const date0 = extractTimestamp(row0Text);
        const date1 = extractTimestamp(row1Text);

        if (date0 && date1 && date0.timestamp < date1.timestamp) {
            console.log(`⚠️ Table sorting layout is Ascending (Oldest first: ${date0.text}). Inverting...`);
            const activationHeader = this.page.locator('th:has-text("Activation Time"), td:has-text("Activation Time")').first();
            await activationHeader.click();
            await this.page.waitForTimeout(2000); 
        }

        // 2. Scan available table lines sequentially to isolate our target date parameters
        const rowCount = await allRows.count();
        const scanLimit = Math.min(rowCount, 8);
        
        for (let i = 0; i < scanLimit; i++) {
            const row = allRows.nth(i);
            const rowText = await row.textContent() || '';
            const parsedInfo = extractTimestamp(rowText);

            if (parsedInfo && parsedInfo.day === targetDay && parsedInfo.month === targetMonth && parsedInfo.year === targetYear) {
                if (rowText.toUpperCase().includes('RUNNING') || rowText.toUpperCase().includes('ACTIVE')) {
                    this.todayRunActive = true;
                }
                console.log(`✅ [Target Lock] Successfully matched execution record at row index [${i}] (${parsedInfo.text})`);
                return row;
            }
        }

        console.warn(`❌ [Target Lock] Target date window not found in history view. Defaulting safely to index 0.`);
        return allRows.first();
    }

    async clickAndExtractFromTableRows(jobNameToSkip) {
        const allRowStats = [];
        const processedLNRs = new Set();
        
        try {
            console.log('Starting row-by-row click and table extraction...');
            const tableBody = this.page.locator('div.v-table-body table.v-table-table tbody');
            await tableBody.waitFor({ state: 'visible', timeout: 10000 });
            await tableBody.focus();

            let lnrToProcess = 1;
            let stableScrollRetries = 0;
            const MAX_STABLE_RETRIES = 5;

            while (stableScrollRetries < MAX_STABLE_RETRIES) {
                const endRow = tableBody.locator('tr', {
                    has: this.page.locator(`td:nth-child(2):text-matches("^\\s*END\\s*$")`)
                });

                if (await endRow.isVisible({ timeout: 250 })) {
                    console.log('Found "END" marker. Finishing processing.');
                    break;
                }
                
                const cellLocator = tableBody.locator(`td:nth-child(1)`).filter({
                    hasText: new RegExp(`^\\s*${lnrToProcess}\\s*$`)
                });

                if (await cellLocator.isVisible({ timeout: 250 })) {
                    stableScrollRetries = 0;
                    const rowLocator = cellLocator.locator('xpath=..');
                    const objectNameInRow = (await rowLocator.locator('td').nth(1).textContent() || '').trim();

                    if (objectNameInRow === 'END') {
                        console.log('Identified "END" row. Finishing processing.');
                        break;
                    }

                    if (objectNameInRow === jobNameToSkip || objectNameInRow === 'START') {
                        console.log(`Skipping LNR ${lnrToProcess} ('${objectNameInRow}' row).`);
                    } else if (!processedLNRs.has(lnrToProcess)) {
                        processedLNRs.add(lnrToProcess);
                        const loopStart = Date.now();
                        try {
                            const innerCell = rowLocator.locator('td').first();
                            await innerCell.click({ timeout: 5000 });
                            
                            if (!this._diagnosticDone) {
                                this._diagnosticDone = true;
                                const allCells = await rowLocator.locator('td').all();
                                console.log(`\n[COLUMN DIAGNOSTIC] First captured job: '${objectNameInRow}'. All cell values:`);
                                for (let i = 0; i < allCells.length; i++) {
                                    const v = (await allCells[i].textContent() || '').trim();
                                    if (v) console.log(`  Cell[${i}]: "${v}"`);
                                }
                            }

                            const cells = await rowLocator.evaluate(tr =>
                                Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim())
                            );
                            const status         = cells[4] || '';
                            const runId          = cells[5] || 'N/A';
                            const activationType = cells[6] || 'N/A';
                            const host           = cells[8] || 'N/A';

                            const { startTime, endTime, runtime } = await this.readDetailsFromPanel();
                            const upperStatus = status.toUpperCase();
                            const isFailed =
                                upperStatus.includes('ENDED_NOT_OK') ||
                                upperStatus.includes('ENDED_CANCEL')  ||
                                upperStatus.includes('FAULTED')        ||
                                upperStatus.includes('ABORTED')        ||
                                upperStatus.includes('BLOCKED')        ||
                                upperStatus.includes('STATUS BLOCKED MANUALLY REMOVED') ||
                                upperStatus.includes('WAITING FOR EXTERNAL') ||
                                upperStatus.includes('WAITING FOR PARALLEL');

                            let errorReason      = '';
                            let restartTriggered = false;

                            if (isFailed) {
                                console.log(`   -> [FAILED] '${objectNameInRow}' | Status: "${status}". Starting analysis...`);
                                errorReason = await this.scrapeJobErrorDetails(objectNameInRow);
                                console.log(`   -> Error reason extracted: "${errorReason}"`);
                                await this.openDetailsPanel();
                                restartTriggered = await this.attemptJobRestart(innerCell, objectNameInRow, runId);
                            }

                            const stats = { objectName: objectNameInRow, runId, status, activationType, startTime, endTime, runtime, host, errorReason, restartTriggered };
                            allRowStats.push({ lnr: String(lnrToProcess), ...stats });
                            console.log(`   - CAPTURED: LNR ${lnrToProcess} ('${objectNameInRow}') | Status: ${status} | ActivType: ${activationType}`);

                        } catch (error) {
                            console.warn(`Could not process row LNR ${lnrToProcess} ('${objectNameInRow}'). Error: ${error.message}`);
                            allRowStats.push({
                                lnr: String(lnrToProcess), objectName: objectNameInRow, status: 'ExtractionError',
                                activationType: 'N/A', startTime: 'N/A', endTime: 'N/A', runtime: 'N/A',
                                errorReason: error.message, restartTriggered: false,
                            });
                        }
                        const loopEnd = Date.now();
                        console.log(`LNR ${lnrToProcess} processed in ${loopEnd - loopStart}ms.`);
                    }
                    lnrToProcess++;
                } else {
                    await this.page.keyboard.press('PageDown');
                    await this.page.waitForLoadState('networkidle', { timeout: 1500 })
                        .catch(() => tableBody.waitFor({ state: 'visible', timeout: 500 }).catch(() => {}));
                    stableScrollRetries++;
                }
            }

            allRowStats.sort((a, b) => parseInt(a.lnr, 10) - parseInt(b.lnr, 10));
            return allRowStats;
        } catch (error) {
            console.error('Error during the process of clicking table rows:', error.message);
            throw error;
        }
    }

    async openDetailsPanel() {
        try {
            await this.page.waitForSelector('button:has-text("Details"), [title="Details"]', { state: 'visible', timeout: 6000 });
            await this.detailsButton.click();
            await this.page.waitForTimeout(300);
        } catch (err) {
            console.warn(`openDetailsPanel: ${err.message}`);
        }
    }

    async readDetailsFromPanel() {
        const result = { startTime: 'N/A', endTime: 'N/A', runtime: 'N/A', activationTime: 'N/A' };
        const dateRe = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)/i;
        const runtimeRe = /^\d+:\d{2}:\d{2}$/;

        await this.page.waitForTimeout(300);

        const parseLines = (rawText) => {
            const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const next = lines[i + 1] || '';
                
                if (/^(?:start|execution\s+start|start\s+time)$/i.test(line) && dateRe.test(next) && result.startTime === 'N/A')
                    result.startTime = next.trim();
                if (/^(?:end|execution\s+end|end\s+time)$/i.test(line) && dateRe.test(next) && result.endTime === 'N/A')
                    result.endTime = next.trim();
                if (/^(?:runtime|duration|execution\s+time)$/i.test(line) && runtimeRe.test(next) && result.runtime === 'N/A')
                    result.runtime = next.trim();
                if (/^(?:activation|activation\s+time)$/i.test(line) && dateRe.test(next) && result.activationTime === 'N/A')
                    result.activationTime = next.trim();

                const m = line.match(/^(start|end|runtime|duration|activation)\s*:?\s+(.+)$/i);
                if (m) {
                    const label = m[1].toLowerCase();
                    const value = m[2].trim();
                    if (label === 'start' && dateRe.test(value) && result.startTime === 'N/A') result.startTime = value;
                    if (label === 'end' && dateRe.test(value) && result.endTime === 'N/A') result.endTime = value;
                    if ((label === 'runtime' || label === 'duration') && runtimeRe.test(value) && result.runtime === 'N/A') result.runtime = value;
                    if (label === 'activation' && dateRe.test(value) && result.activationTime === 'N/A') result.activationTime = value;
                }
            }
        };

        try {
            const deepText = await this.page.evaluate(() => {
                function getDeepText(node) {
                    let t = '';
                    if (node.shadowRoot) t += getDeepText(node.shadowRoot);
                    for (const child of node.childNodes) {
                        if (child.nodeType === 3) {
                            const v = (child.textContent || '').trim();
                            if (v) t += v + '\n';
                        } else if (child.nodeType === 1) {
                            t += getDeepText(child);
                        }
                    }
                    return t;
                }
                const panel = document.querySelector('ecc-details-view, [data-role="details-panel"], .v-splitpanel-second-container, .details-container');
                return getDeepText(panel || document.body);
            });
            parseLines(deepText);
        } catch (e) {
            console.warn(`[DetailPanel] Shadow DOM traversal failed: ${e.message}`);
        }

        if (result.startTime === 'N/A' || result.activationTime === 'N/A') {
            for (const sel of ['.v-splitpanel-second-container', 'ecc-details-view', '[data-role="details-panel"]']) {
                try {
                    const panel = this.page.locator(sel).first();
                    if (!(await panel.isVisible({ timeout: 300 }))) continue;
                    parseLines(await panel.innerText());
                    if (result.startTime !== 'N/A' && result.activationTime !== 'N/A') break;
                } catch (_e) {}
            }
        }
        return result;
    }

    async scrapeJobErrorDetails(objectName) {
        const ERROR_PATTERNS = [
            { regex: /timeout/i, reason: 'Timeout' },
            { regex: /missing\s+dependency|dependency.*not.*found/i, reason: 'Missing Dependency' },
            { regex: /connection\s+refused|unable\s+to\s+connect/i, reason: 'Connection Failure' },
            { regex: /file\s+not\s+found|no\s+such\s+file/i, reason: 'File Not Found' },
            { regex: /permission\s+denied|access\s+denied/i, reason: 'Permission Denied' },
            { regex: /out\s+of\s+memory|heap\s+space/i, reason: 'Out of Memory' },
            { regex: /aborted|cancelled|canceled/i, reason: 'Aborted/Cancelled' },
        ];

        const pageUrlBefore = this.page.url();
        try {
            await this.page.waitForSelector('button:has-text("Details"), [title="Details"]', { state: 'visible', timeout: 6000 });
            await this.detailsButton.click();

            await this.page.waitForSelector('ecc-details-view, [data-role="details-panel"]', { state: 'visible', timeout: 4000 });

            const tab = this.page.locator('[role="tab"]:has-text("Report"), [role="tab"]:has-text("Log"), button:has-text("Report")').first();
            if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
                await tab.click();
                await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
            }

            let rawLogText = '';
            for (const sel of ['pre', 'textarea[readonly]', '.log-content', 'ecc-report-viewer']) {
                try {
                    rawLogText = await this.page.locator(sel).first().innerText();
                    if (rawLogText && rawLogText.trim()) break;
                } catch (_e) {}
            }

            if (!rawLogText || !rawLogText.trim()) return 'Log content empty or unavailable';

            for (const { regex, reason } of ERROR_PATTERNS) {
                if (regex.test(rawLogText)) return reason;
            }

            const lines = rawLogText.split('\n').map(l => l.trim()).filter(Boolean);
            const errorLine = lines.find(l => l.toLowerCase().includes('error') || l.toLowerCase().includes('fail'));
            return errorLine ? errorLine.substring(0, 150) : 'Unknown Error (check logs)';
        } catch (error) {
            return 'Scraping failed — see console';
        } finally {
            try {
                const closeBtn = this.page.locator('button[aria-label="Close"], button:has-text("Close")').first();
                if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) await closeBtn.click();
            } catch (_e) {}
            if (this.page.url() !== pageUrlBefore) {
                try { await this.page.goBack({ Frank: 'networkidle', timeout: 15000 }); } catch (_e) {}
            }
            try {
                if (await this.layOutButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await this.layOutButton.click();
                    await this.page.locator('div.v-table-body table.v-table-table tbody').waitFor({ state: 'visible', timeout: 8000 });
                }
            } catch (_e) {}
        }
    }

    async attemptJobRestart(innerCellLocator, objectName, runId) {
        if (!runId || runId === 'N/A') return false;
        if (this.restartedRunIds.has(runId)) return false;

        try {
            await innerCellLocator.click({ button: 'right', timeout: 5000 });
            await this.page.waitForSelector('[role="menu"], .v-contextmenu', { state: 'visible', timeout: 4000 });

            const option = this.page.locator('[role="menuitem"]:has-text("Restart"), li:has-text("Restart Task")').first();
            if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
                await option.click();
                
                try {
                    const confirmBtn = this.page.locator('[role="dialog"] button:has-text("OK"), button:has-text("Confirm")').first();
                    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) await confirmBtn.click();
                } catch (_e) {}

                await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
                this.restartedRunIds.add(runId);
                return true;
            }
            await this.page.keyboard.press('Escape');
            return false;
        } catch (error) {
            await this.page.keyboard.press('Escape').catch(() => {});
            return false;
        }
    }
}

module.exports = JobPage;