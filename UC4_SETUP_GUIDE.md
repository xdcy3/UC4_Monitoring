# UC4 Automation Suite - Complete Setup Guide

This guide covers the complete setup process for the UC4 Automation Suite, including local installation, GitHub repository setup, and GitHub Actions workflow configuration.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Setup](#local-setup)
3. [GitHub Repository Setup](#github-repository-setup)
4. [GitHub Actions Workflow Configuration](#github-actions-workflow-configuration)
5. [Scheduling & Execution](#scheduling--execution)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### System Requirements
- **Operating System**: Windows 10/11 or macOS/Linux
- **Node.js**: v18.x or higher (v20 LTS recommended)
- **npm**: v8.x or higher (bundled with Node.js)
- **Git**: v2.30 or higher
- **GitHub Account**: With repository access

### Software to Install

#### 1. Node.js & npm
1. Visit https://nodejs.org/
2. Download LTS version (currently v20)
3. Run installer and follow prompts
4. Verify installation:
   ```powershell
   node --version
   npm --version
   ```

#### 2. Git
1. Visit https://git-scm.com/download/win
2. Download and run installer
3. Use default settings (or customize as needed)
4. Verify installation:
   ```powershell
   git --version
   ```

#### 3. Code Editor (Optional but Recommended)
- Visual Studio Code: https://code.visualstudio.com/
- Install Playwright Test for VS Code extension for better test visibility

---

## Local Setup

### Step 1: Clone the Repository

```powershell
git clone https://github.com/xdcy3/UC4_Monitoring.git
cd UC4_Monitoring
```

### Step 2: Install Root Dependencies

```powershell
npm ci
```

### Step 3: Navigate to Test Suite

```powershell
cd "UC4_Automation_Suite - share"
```

### Step 4: Install Test Dependencies

```powershell
npm ci
npx playwright install chromium
```

This installs:
- **Playwright**: Browser automation framework
- **Chromium**: Browser engine for tests

### Step 5: Configure Environment Variables

Create a `.env` file in the `UC4_Automation_Suite - share` directory:

```env
UC4USERNAME=your_username
UC4PASSWORD=your_password
EMAIL_USER=your_email@example.com
EMAIL_PASS=your_app_specific_password
EMAIL_TO=recipient@example.com
SSH_HOST=your_ssh_host
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/d/YOUR_SCRIPT_ID/usercopy
GOOGLE_SHEET_TAB=Sheet1
TEAMS_WEBHOOK_URL=https://outlook.webhook.office.com/webhookb2/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

**Note**: For Gmail:
- Use your Gmail email address
- Generate an [App Password](https://myaccount.google.com/apppasswords) (2FA must be enabled)
- Use the 16-character app password, not your regular Gmail password

### Step 6: Run Tests Locally

```powershell
npx playwright test tests/FullSuiteRun.spec.js
```

To run with UI mode (recommended for development):
```powershell
npx playwright test tests/FullSuiteRun.spec.js --ui
```

To run in headed mode (see browser):
```powershell
npx playwright test tests/FullSuiteRun.spec.js --headed
```

---

## GitHub Repository Setup

### Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `UC4_Monitoring`
3. Description: "UC4 Automation Suite - Nonprod Testing"
4. Set to **Private** (recommended for credentials)
5. Initialize with README (optional)
6. Click "Create repository"

### Step 2: Configure Repository Settings

#### 2a. SSH Key Setup for Push Access

On your local machine:

```powershell
# Generate SSH key (ed25519 format, no passphrase)
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519 -N ""

# Display the public key
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

In GitHub:
1. Go to Settings → SSH and GPG keys → New SSH key
2. Paste the public key content
3. Title: "UC4 Automation Machine"
4. Click "Add SSH key"

Verify connection:
```powershell
ssh -T git@github.com
# Expected: "Hi xdcy3! You've successfully authenticated"
```

#### 2b. Configure Branch Protection Rules

1. Go to repository Settings → Branches
2. Add rule for `main` branch:
   - Require pull request reviews before merging
   - Dismiss stale pull request approvals when new commits are pushed
   - Require status checks to pass before merging (optional)
   - Require branches to be up to date before merging (optional)

#### 2c. Enable GitHub Actions

1. Go to Settings → Actions → General
2. Ensure "Allow all actions and reusable workflows" is selected
3. Enable "Allow GitHub Actions to create and approve pull requests"

### Step 3: Add Repository Secrets

GitHub Actions workflows need secrets for sensitive data. Never commit credentials directly.

1. Go to Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add each secret:

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `UC4USERNAME` | Your UC4 username | XDCY3 |
| `UC4PASSWORD` | Your UC4 password | Your actual password |
| `EMAIL_USER` | Your email address | dchakravarthy1@woolworths.com.au |
| `EMAIL_PASS` | Gmail app password | 16-character app-specific password |
| `EMAIL_TO` | Recipient email | dchakravarthy1@woolworths.com.au |

**Important**: These are reference secrets. The workflow reads them via `${{ secrets.SECRET_NAME }}`.

### Step 4: Push Local Repository to GitHub

```powershell
cd C:\Users\xdcy3\Downloads\UC4_Automation_Suite_Nonprod

# Add remote origin
git remote add origin git@github.com:xdcy3/UC4_Monitoring.git

# Verify remote
git remote -v

# Push to main (if branch protection rules are set up, use a different branch first)
git push -u origin main
```

If push is blocked by branch protection:
```powershell
# Push to a feature branch instead
git push -u origin feature/initial-setup

# Then create a Pull Request on GitHub to merge into main
```

---

## GitHub Actions Workflow Configuration

### Workflow File Location
`.github/workflows/uc4-daily.yml`

### What the Workflow Does

1. **Trigger**: Runs on schedule (daily at 06:00 UTC) or manually via workflow_dispatch
2. **Setup**: Checks out code, installs Node.js, installs dependencies
3. **Test Execution**: Runs Playwright tests 2 times (with retry logic)
4. **Artifact Upload**: Stores test reports and results
5. **Notifications**: Sends Teams/Slack messages on completion

### Workflow Structure

```yaml
name: UC4 Daily Full Suite

on:
  schedule:
    - cron: '0 6 * * *'  # Daily at 06:00 UTC
  workflow_dispatch:     # Manual trigger

jobs:
  test:
    runs-on: windows-latest  # GitHub-hosted Windows runner
    steps:
      # 1. Check out repository code
      - uses: actions/checkout@v4
      
      # 2. Setup Node.js
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      # 3. Install dependencies
      - name: Install test dependencies
        run: |
          Push-Location './UC4_Automation_Suite - share'
          npm ci
          npx playwright install chromium
          Pop-Location
      
      # 4. Run tests (with retry logic)
      - name: Run UC4 full suite
        run: |
          Push-Location './UC4_Automation_Suite - share'
          npx playwright test tests/FullSuiteRun.spec.js
          Pop-Location
      
      # 5. Upload artifacts (always runs, even if tests fail)
      - name: Upload test artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: ./UC4_Automation_Suite - share/playwright-report
      
      # 6. Notify on completion
      - name: Send notifications
        if: always()
        run: |
          # Send Teams notification
          # Send Slack notification
          # Send email notification
```

### Key Configuration Details

#### Environment Variables
```yaml
env:
  CI: true  # Indicates running in CI environment
  UC4USERNAME: ${{ secrets.UC4USERNAME }}
  UC4PASSWORD: ${{ secrets.UC4PASSWORD }}
  EMAIL_USER: ${{ secrets.EMAIL_USER }}
  EMAIL_PASS: ${{ secrets.EMAIL_PASS }}
```

#### Working Directory
- All paths are relative to repository root: `./UC4_Automation_Suite - share`
- Uses `Push-Location` / `Pop-Location` for directory changes

#### Retry Logic
- Tests run up to 2 times if they fail
- Second attempt runs only if first attempt fails
- Configurable in `playwright.config.js`

---

## Scheduling & Execution

### View Workflow Runs

1. Go to your repository on GitHub
2. Click "Actions" tab
3. Click "UC4 Daily Full Suite" workflow
4. All runs are listed with status (✅ passed, ❌ failed, ⏳ in progress)

### Manual Execution

To run the workflow immediately without waiting for the schedule:

1. Go to repository "Actions" tab
2. Click "UC4 Daily Full Suite" workflow
3. Click "Run workflow" button
4. Select branch: `main`
5. Click "Run workflow"
6. Workflow begins immediately

### Scheduled Execution

The workflow automatically runs every day at **06:00 UTC** (approximately 16:00 IST / 4:00 PM).

**To change the schedule:**

Edit `.github/workflows/uc4-daily.yml`:

```yaml
on:
  schedule:
    - cron: '0 6 * * *'  # Change the time here
```

**Cron schedule format**: `minute hour day month dayOfWeek`

**Examples**:
- `0 6 * * *` = Every day at 06:00 UTC
- `0 9 * * 1-5` = Weekdays at 09:00 UTC
- `0 0 * * 0` = Every Sunday at 00:00 UTC (midnight UTC)
- `*/30 * * * *` = Every 30 minutes

**Note**: GitHub Actions times are always in UTC. Adjust for your timezone accordingly.

### Check Workflow Status

1. **From GitHub**: Actions tab shows green checkmark (✅) or red X (❌)
2. **View Logs**: Click on a workflow run to see detailed output
3. **Artifacts**: Download test reports, screenshots, videos
4. **Email/Slack**: Receive notifications (if configured)

### Download Test Results

After workflow completes:

1. Open workflow run in GitHub
2. Scroll to "Artifacts" section
3. Download:
   - `playwright-report` - HTML test report with screenshots
   - Test execution logs

### Failed Workflow Debugging

If workflow fails:

1. Click the failed run
2. Expand the failed step
3. Check the error message
4. Common issues:
   - **Network error**: Internal URL unreachable from GitHub runner (expected for nonprod)
   - **Authentication error**: Check secrets are configured correctly
   - **Dependency error**: Check `package.json` is correct
   - **Timeout**: Tests taking too long, adjust timeouts in `playwright.config.js`

---

## File Structure

```
UC4_Monitoring/
├── .github/
│   └── workflows/
│       └── uc4-daily.yml              # GitHub Actions workflow
├── .gitignore                         # Git ignore rules
├── UC4_Automation_Suite - share/
│   ├── package.json                   # Test dependencies
│   ├── package-lock.json
│   ├── playwright.config.js           # Playwright configuration
│   ├── pageObject/
│   │   ├── UC4loginpage.js
│   │   └── UC4jobpage.js
│   ├── tests/
│   │   └── FullSuiteRun.spec.js      # Main test file
│   ├── test-data/                     # Input data files
│   ├── utils/
│   │   ├── GoogleSheetUpdater.js      # Update Google Sheets
│   │   ├── LogFetcher.js
│   │   ├── WebhookNotifier.js         # Send Teams/Slack
│   │   └── AppsScript_SheetUpdater.gs # Google Apps Script
│   └── .env                           # Local environment variables (not in git)
├── package.json
├── run-tests.cmd                      # Local batch script
└── UC4_SETUP_GUIDE.md                # This file
```

---

## Security Best Practices

1. **Never commit secrets**: Use GitHub Secrets, not `.env` files
2. **Use .gitignore**: Exclude `node_modules`, `.env`, test results
3. **Rotate credentials**: Change passwords regularly
4. **Use SSH keys**: Ed25519 recommended over HTTPS tokens
5. **Review code**: Always review PRs before merging to main
6. **Limit access**: Restrict who can approve PRs
7. **Enable branch protection**: Require reviews and status checks
8. **Monitor runs**: Check GitHub Actions logs regularly

---

## Troubleshooting

### Error: "net::ERR_NAME_NOT_RESOLVED"

**Cause**: GitHub runner cannot reach internal URLs (expected for nonprod environments)

**Solution**: Use self-hosted runner on internal network
- See [GitHub Self-Hosted Runners](https://docs.github.com/en/actions/hosting-your-own-runners)

### Error: "push declined due to repository rule violations"

**Cause**: Secrets detected in commit

**Solution**: 
1. Never commit secrets directly
2. Use GitHub Secrets instead
3. If accidentally committed, rotate the credential
4. Use `.gitignore` to prevent it

### Error: "Dependencies lock file is not found"

**Cause**: `package-lock.json` is missing or in wrong location

**Solution**: Ensure `package-lock.json` exists in `UC4_Automation_Suite - share/`
```powershell
cd "UC4_Automation_Suite - share"
npm ci --legacy-peer-deps
```

### Tests fail locally but you need to run workflow

**Debug steps**:
1. Check `.env` has correct credentials
2. Verify internal URLs are accessible
3. Check Playwright browser is installed:
   ```powershell
   npx playwright install chromium
   ```
4. Run tests in UI mode to see issues:
   ```powershell
   npx playwright test --ui
   ```

### Workflow runs but tests hang or timeout

**Solutions**:
1. Increase timeout in `playwright.config.js`:
   ```javascript
   timeout: 60000  // 60 seconds
   ```
2. Check if internal service is responding
3. Add debug output to test file
4. Check GitHub runner has sufficient resources

---

## Next Steps

1. **Set up self-hosted runner** if tests need to access internal networks
2. **Configure email notifications** via Gmail app passwords
3. **Set up Teams/Slack webhooks** for instant alerts
4. **Monitor first few runs** to ensure reliability
5. **Document test data** and maintenance procedures
6. **Establish on-call rotation** for failed workflow handling

---

## References

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Playwright Documentation](https://playwright.dev)
- [GitHub Secrets Management](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [Self-Hosted Runners](https://docs.github.com/en/actions/hosting-your-own-runners)
- [Cron Schedule Syntax](https://crontab.guru/)

---

## Support

For issues or questions:
1. Check GitHub Actions logs for detailed error messages
2. Review this guide's Troubleshooting section
3. Check Playwright documentation for browser automation issues
4. Contact your GitHub org admin for runner configuration
