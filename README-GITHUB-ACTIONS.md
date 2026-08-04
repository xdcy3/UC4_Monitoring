# GitHub Actions setup

To run the UC4 suite from GitHub automatically:

1. Add these GitHub repository secrets:
   - UC4USERNAME
   - UC4PASSWORD
   - EMAIL_USER
   - EMAIL_PASS
   - EMAIL_TO
   - GOOGLE_APPS_SCRIPT_URL (optional)
   - GOOGLE_SHEET_TAB (optional)
   - TEAMS_WEBHOOK_URL (optional)
   - SLACK_WEBHOOK_URL (optional)

2. Enable Actions for the repository.

3. The workflow runs on a schedule at 06:00 UTC every day and can also be started manually from the Actions tab.
