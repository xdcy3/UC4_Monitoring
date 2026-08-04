/** 
 * FullSuiteRun.spec.js
 * Run all process flows defined in the input CSV sequentially (workers: 1).
 */
const { test, expect } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const JobPage    = require('../pageObject/UC4jobpage');
const LoginPage  = require('../pageObject/UC4loginpage');
const LogFetcher = require('../utils/LogFetcher');

// Load configurations from the PFs CSV
const records = parse(
    fs.readFileSync(path.join(__dirname, '../test-data/PFs.CSV')),
    { columns: true, skip_empty_lines: true }
);
const TOTAL_FLOWS = records.length;

const outputFilePath        = path.join(__dirname, '../test-data/failed_FullSuite.csv');
const allJobsOutputFilePath = path.join(__dirname, '../test-data/all_jobs_log.csv');
const csvHeaders            = 'JobID,JobName,ObjectName,RunID,Status,StartTime,EndTime,Runtime,Host';

// Initialization scripts
[outputFilePath, allJobsOutputFilePath].forEach(fp => {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    fs.writeFileSync(fp, `${csvHeaders}\n`, { encoding: 'utf8' });
});

const now = new Date();
const timestampForFile = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
const suiteStartTime   = Date.now();

test.describe.serial('59-Flow Full Suite Run', () => {
    let context, page, loginPage, jobPage;
    let hasTestInfrastructureFailed = false;
    const parentStatuses = {};

    // One-time setup to reuse a single authenticated browser session for all flows
    test.beforeAll(async ({ browser }) => {
        test.setTimeout(3600000);
        context   = await browser.newContext();
        page      = await context.newPage();
        loginPage = new LoginPage(page);
        jobPage   = new JobPage(page, expect);

        try {
            await loginPage.goTo();
            await loginPage.login('300', process.env.UC4USERNAME, process.env.UC4PASSWORD);
        } catch (err) {
            hasTestInfrastructureFailed = true;
            console.error('❌ Suite setup failed during login:', err.message);
            throw err;
        }
    });

    test.afterAll(async () => {
        try {
            if (context) {
                await context.close();
            }
        } catch (e) {
            console.warn('Non-fatal context teardown catch:', e.message);
        }
    });

    test('Full suite execution in a single session', async () => {
        if (hasTestInfrastructureFailed) test.skip();
        test.setTimeout(3600000);

        for (const record of records) {
            console.log(`\n${'-'.repeat(60)}\n[${record.JobID}/${TOTAL_FLOWS}] ${record.JobName}\n${'-'.repeat(60)}`);

            try {
                const { parentStatus, jobs: allJobStats } = await jobPage.searchJob(record.JobName, record.JobDetail);
                parentStatuses[record.JobID] = parentStatus;
                let failedCount = 0;

                for (const stat of allJobStats) {
                    const allRow = `"${record.JobID}","${record.JobName}","${(stat.objectName || '').trim()}","${(stat.runId || 'N/A').trim()}","${(stat.status || 'N/A').trim()}","${(stat.startTime || 'N/A').trim()}","${(stat.endTime || 'N/A').trim()}","${(stat.runtime || 'N/A').trim()}","${(stat.host || 'N/A').trim()}"`;
                    fs.writeFileSync(allJobsOutputFilePath, `${allRow}\n`, { flag: 'a', encoding: 'utf8' });

                    const st = (stat.status || '').toUpperCase();
                    if (['ENDED_NOT_OK', 'ENDED_CANCEL', 'FAULTED', 'ABORTED', 'BLOCKED', 'WAITING FOR EXTERNAL', 'WAITING FOR PARALLEL'].some(k => st.includes(k))) {
                        fs.writeFileSync(outputFilePath, `${allRow}\n`, { flag: 'a', encoding: 'utf8' });
                        failedCount++;
                    }
                }

                console.log(`[${record.JobID}/${TOTAL_FLOWS}] Done — ${allJobStats.length} sub-jobs | ${failedCount} failed`);

                if (failedCount > 0) {
                    console.warn(`⚠️ [Flow Status] Flow ${record.JobID} (${record.JobName}) completed with ${failedCount} failed sub-job(s). Logged for PDF report.`);
                }
            } catch (err) {
                if (err.message && err.message.startsWith('No results found for JobName')) {
                    console.warn(`[${record.JobID}/${TOTAL_FLOWS}] Not found in UC4: "${record.JobName}"`);
                    const row = `"${record.JobID}","${record.JobName}","N/A","N/A","Not found in UC4","N/A","N/A","N/A","N/A"`;
                    fs.writeFileSync(outputFilePath, `${row}\n`, { flag: 'a', encoding: 'utf8' });
                    fs.writeFileSync(allJobsOutputFilePath, `${row}\n`, { flag: 'a', encoding: 'utf8' });
                    parentStatuses[record.JobID] = 'NOT FOUND';
                } else if (err.message && err.message.includes('STALE EXECUTION DETECTED')) {
                    const match = err.message.match(/LAST_RAN:([^\n|]+)/);
                    const date = match ? match[1].trim() : 'Unknown';
                    console.warn(`[${record.JobID}/${TOTAL_FLOWS}] Not Triggered: "${record.JobName}" | Last run: ${date}`);
                    const row = `"${record.JobID}","${record.JobName}","Last ran: ${date}","N/A","NOT_TRIGGERED","N/A","N/A","N/A","N/A"`;
                    fs.writeFileSync(outputFilePath, `${row}\n`, { flag: 'a', encoding: 'utf8' });
                    fs.writeFileSync(allJobsOutputFilePath, `${row}\n`, { flag: 'a', encoding: 'utf8' });
                    parentStatuses[record.JobID] = 'NOT_TRIGGERED';
                } else {
                    console.error(`[${record.JobID}/${TOTAL_FLOWS}] Unexpected error: ${err.message.split('\n')[0]}`);
                    const row = `"${record.JobID}","${record.JobName}","Unexpected error","N/A","ERROR","N/A","N/A","N/A","N/A"`;
                    fs.writeFileSync(outputFilePath, `${row}\n`, { flag: 'a', encoding: 'utf8' });
                    fs.writeFileSync(allJobsOutputFilePath, `${row}\n`, { flag: 'a', encoding: 'utf8' });
                    if (!parentStatuses[record.JobID]) {
                        parentStatuses[record.JobID] = 'ERROR';
                    }
                }
            }
        }
    });

    test.afterAll(async () => {
        if (hasTestInfrastructureFailed) return;
        console.log('\n Generating PDF and sending email... ');
        try {
            const logFetcher = new LogFetcher(outputFilePath, timestampForFile, suiteStartTime);
            await logFetcher.processFailedJobs(parentStatuses, records);
            console.log(`Dispatched to: ${process.env.EMAIL_TO}`);           
        } catch (err) {
            console.error('Email report compilation error:', err.message);
        }
    });
});