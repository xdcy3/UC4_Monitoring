# Google Sheet Auto-Update — Setup Guide
## Option B: Google Apps Script Web App

This guide walks you through connecting the UC4 Process Flow Automation to your Google Sheet so that after every overnight run, the status and failed jobs are written automatically into the sheet — matching the colour format of columns N and O.

---

## What You Need Before Starting

- Access to the Google Sheet (editor permission)
- The file `utils/AppsScript_SheetUpdater.gs` (already in this project)
- Access to `.env.validation` (already in this project)

---

## Step 1 — Open Apps Script in the Google Sheet

1. Open your Google Sheet: **Relex Order Management — Process Flow Monitoring**
2. In the top menu, click **Extensions → Apps Script**
3. A new browser tab will open with the Apps Script editor

---

## Step 2 — Paste the Script

1. In the Apps Script editor, you will see a default file called `Code.gs`
2. **Select all** the existing code (`Ctrl + A`) and **delete it**
3. Open the file `utils/AppsScript_SheetUpdater.gs` from this project (any text editor)
4. **Copy all** the content and **paste it** into the Apps Script editor
5. Click the **Save** button (floppy disk icon) or press `Ctrl + S`
6. Give the project a name if prompted — e.g. **UC4 Sheet Updater**

---

## Step 3 — Deploy as a Web App

1. Click **Deploy** (top right) → **New Deployment**
2. Click the gear icon ⚙️ next to **Type** and select **Web App**
3. Fill in the settings:

   | Field | Value |
   |---|---|
   | Description | UC4 Process Flow Sheet Updater |
   | Execute as | **Me** (your Google account) |
   | Who has access | **Anyone** |

4. Click **Deploy**
5. If prompted, click **Authorize access** → choose your Google account → click **Allow**
6. You will see a screen saying **Deployment created**
7. Copy the **Web App URL** — it looks like:
   ```
   https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/exec
   ```
   > ⚠️ Keep this URL safe — anyone with this URL can trigger the script

---

## Step 4 — Add the URL to the Project

1. Open `.env.validation` in this project
2. Find the section at the bottom:
   ```
   GOOGLE_APPS_SCRIPT_URL=
   GOOGLE_SHEET_TAB=Critical for End to End Testing
   ```
3. Paste your Web App URL:
   ```
   GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbXXXXXXXXXX/exec
   GOOGLE_SHEET_TAB=Critical for End to End Testing
   ```
4. If your sheet tab has a different name, update `GOOGLE_SHEET_TAB` to match exactly

---

## Step 5 — Test the Script Manually (Optional but Recommended)

Before running the full Playwright suite, you can test the Apps Script directly:

1. In the Apps Script editor, open the function dropdown (top centre) and select `_testManually`
2. Click **Run** (▶ play button)
3. Open your Google Sheet and check if a new date column appeared with test data
4. Verify the colours match:
   - 🟢 **Completed** — green background, white text
   - 🟠 **In Progress** — orange background, black text
   - 🔴 **Blocked** — dark red background, white text
   - 🟡 **Yet to Start** — yellow background, black text

---

## Step 6 — Run the Full Suite

Run the normal Playwright test as usual:

```powershell
cd "C:\Process Flow Automation\UC4ProcessFlow"
.\node_modules\.bin\playwright test tests/FullSuiteRun.spec.js --project=chromium
```

After the test completes, watch the console for:
```
[GoogleSheet] Posting 41 flows to Apps Script (tab: "Critical for End to End Testing")...
[GoogleSheet] ✅ Sheet updated — 41 rows written.
```

The Google Sheet will now have a new date column with statuses and comments filled in automatically.

---

## What Gets Written

For each process flow in column A of the sheet:

| Flow Status | Cell Value | Comment Written |
|---|---|---|
| Completed (no failures) | Completed | `No Failures` |
| Completed (with failures) | Completed | `Failed Jobs :\n1)JobName` |
| Blocked | Blocked | `Failed Jobs :\n1)JobName` |
| Waiting on dependency | In Progress | `Waiting for <UC4 status text>` |
| Not yet started | Yet to Start | `Not triggered in overnight batch` |

> If a process flow name in the sheet (column A) does not exactly match the name in `inputFullSuiteJobs.csv`, that row will be skipped. Make sure the names match.

---

## Important Notes

### After Any Script Code Change — Redeploy
If you ever modify `AppsScript_SheetUpdater.gs` and paste it again, you **must create a NEW deployment** (not manage existing). The live URL only runs the version that was deployed.

Steps:
1. Click **Deploy → New Deployment** (not "Manage deployments")
2. Copy the new URL and update `.env.validation`

### If the Sheet Update Fails
- The email and PDF will still be sent normally — the sheet update is non-fatal
- Check the console log for `[GoogleSheet] ⚠️` warning messages
- Common causes:
  - Web App URL not saved in `.env.validation`
  - Sheet tab name does not match `GOOGLE_SHEET_TAB`
  - Apps Script authorization expired → re-deploy

### Skipping the Sheet Update
To disable the sheet update without removing the code, simply clear the URL in `.env.validation`:
```
GOOGLE_APPS_SCRIPT_URL=
```

---

## File Reference

| File | Description |
|---|---|
| `utils/AppsScript_SheetUpdater.gs` | Paste this into Google Apps Script |
| `utils/GoogleSheetUpdater.js` | Node.js class that posts data (no setup needed) |
| `.env.validation` | Add your Web App URL here |
