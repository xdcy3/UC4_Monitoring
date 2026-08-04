/**
 * UC4 Process Flow Monitoring — Google Apps Script Web App
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP INSTRUCTIONS (one-time):
 *   1. Open your Google Sheet
 *   2. Click Extensions → Apps Script
 *   3. Delete all existing code and paste this entire file
 *   4. Click Deploy → New Deployment
 *        Type: Web App
 *        Execute as: Me
 *        Who has access: Anyone
 *   5. Click Deploy → copy the Web App URL
 *   6. Paste the URL into .env.validation:
 *        GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
 *
 * ⚠️  After ANY code change, you must create a NEW deployment (not re-deploy the
 *     same version) — otherwise the live endpoint keeps running the old code.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Cell background colours matching columns N/O style ───────────────────────
var BG_COLORS = {
  'Completed':    '#00b050',   // green
  'In Progress':  '#ff9900',   // orange
  'Blocked':      '#cc0000',   // dark red
  'Yet to Start': '#ffff00',   // yellow
};

// ── Foreground (text) colours ─────────────────────────────────────────────────
var FG_COLORS = {
  'Completed':    '#ffffff',   // white text on green
  'In Progress':  '#000000',   // black text on orange
  'Blocked':      '#ffffff',   // white text on red
  'Yet to Start': '#000000',   // black text on yellow
};

// ── Entry point — called by every POST request ────────────────────────────────
function doPost(e) {
  try {
    var payload  = JSON.parse(e.postData.contents);
    var tabName  = payload.tabName  || 'Critical for End to End Testing';
    var dateLabel = payload.dateLabel; // "DD/MM/YY"
    var flows    = payload.flows    || [];

    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(tabName);

    if (!sheet) {
      return _json({ success: false, error: 'Tab not found: ' + tabName });
    }

    // ── Read all existing data ────────────────────────────────────────────────
    var lastRow = sheet.getLastRow();
    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var allData = lastRow > 0
      ? sheet.getRange(1, 1, lastRow, lastCol).getValues()
      : [[]];

    // ── Find the header row (row that contains a date like "DD/MM/YY") ───────
    var dateRe = /^\d{2}\/\d{2}\/\d{2}/;
    var headerRowIdx = 0;
    for (var r = 0; r < Math.min(allData.length, 5); r++) {
      var found = allData[r].some(function(cell) {
        return dateRe.test(String(cell || '').trim());
      });
      if (found) { headerRowIdx = r; break; }
    }

    // ── Find or create today's status + comments columns ─────────────────────
    var headerRow     = allData[headerRowIdx] || [];
    var statusColIdx  = -1;
    var commentColIdx = -1;

    for (var c = 0; c < headerRow.length; c++) {
      var cellVal = String(headerRow[c] || '').trim();
      if (cellVal.indexOf(dateLabel) === 0) {
        statusColIdx  = c;
        commentColIdx = c + 1;
        break;
      }
    }

    if (statusColIdx === -1) {
      // Append two new columns after existing data
      statusColIdx  = lastCol;       // 0-based
      commentColIdx = lastCol + 1;

      // Write status header
      var statusHeader = sheet.getRange(headerRowIdx + 1, statusColIdx + 1);
      statusHeader.setValue(dateLabel + '\nOvernight Run');
      _formatHeader(statusHeader);

      // Write comments header
      var commentsHeader = sheet.getRange(headerRowIdx + 1, commentColIdx + 1);
      commentsHeader.setValue('Comments');
      _formatHeader(commentsHeader);

      // Auto-resize the new columns
      sheet.autoResizeColumn(statusColIdx + 1);
      sheet.setColumnWidth(commentColIdx + 1, 350);
    }

    // ── Build process-flow name → 1-based row number map from column A ───────
    var flowRowMap = {};
    for (var row = headerRowIdx + 1; row < allData.length; row++) {
      var name = String(allData[row][0] || '').trim();
      if (name) flowRowMap[name] = row + 1; // 1-based sheet row
    }

    // ── Write each flow's status and comment ─────────────────────────────────
    var written = 0;
    for (var f = 0; f < flows.length; f++) {
      var flow   = flows[f];
      var rowNum = flowRowMap[flow.jobName];
      if (!rowNum) continue; // process flow not in sheet column A — skip

      var label   = flow.status  || '';
      var comment = flow.comment || '';

      // Status cell
      var statusCell = sheet.getRange(rowNum, statusColIdx + 1);
      statusCell.setValue(label);
      statusCell.setBackground(BG_COLORS[label]  || '#f0f0f0');
      statusCell.setFontColor(FG_COLORS[label]   || '#000000');
      statusCell.setFontWeight('bold');
      statusCell.setFontFamily('Arial');
      statusCell.setFontSize(10);
      statusCell.setHorizontalAlignment('center');
      statusCell.setVerticalAlignment('middle');
      statusCell.setWrap(true);

      // Comment cell
      var commentCell = sheet.getRange(rowNum, commentColIdx + 1);
      commentCell.setValue(comment);
      commentCell.setBackground('#ffffff');
      commentCell.setFontColor('#000000');
      commentCell.setFontWeight('normal');
      commentCell.setFontFamily('Arial');
      commentCell.setFontSize(10);
      commentCell.setHorizontalAlignment('left');
      commentCell.setVerticalAlignment('top');
      commentCell.setWrap(true);

      written++;
    }

    // Auto-fit the status column width
    sheet.autoResizeColumn(statusColIdx + 1);

    return _json({ success: true, updated: written });

  } catch (err) {
    return _json({ success: false, error: err.toString() });
  }
}

// ── Helper: format a header cell (dark grey background, white bold Arial) ─────
function _formatHeader(cell) {
  cell.setBackground('#404040');
  cell.setFontColor('#ffffff');
  cell.setFontWeight('bold');
  cell.setFontFamily('Arial');
  cell.setFontSize(10);
  cell.setHorizontalAlignment('center');
  cell.setVerticalAlignment('middle');
  cell.setWrap(true);
}

// ── Helper: return a JSON ContentService response ─────────────────────────────
function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Optional: test the script manually from Apps Script editor ────────────────
function _testManually() {
  var mockEvent = {
    postData: {
      contents: JSON.stringify({
        tabName:   'Critical for End to End Testing',
        dateLabel: '23/05/26',
        flows: [
          { jobName: 'RPLSSRC12PMRD',  status: 'Completed',   comment: 'No Failures' },
          { jobName: 'RPLSSRC12PCFC',  status: 'In Progress',  comment: 'Waiting for ARPLSSRC12PDCM dependency' },
          { jobName: 'RPLBSFF17PFUL',  status: 'Blocked',      comment: 'Failed Jobs :\n1)ARPLBSFF17JA59 - BIGW SRE Calculate Plan for Sprint' },
          { jobName: 'RPLSDFF11PLSF',  status: 'Yet to Start', comment: 'Waiting for RPLBSFF17PFUL dependency' },
        ]
      })
    }
  };
  var result = doPost(mockEvent);
  Logger.log(result.getContent());
}
