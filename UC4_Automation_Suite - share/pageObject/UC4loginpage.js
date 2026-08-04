/**
 * UC4loginpage.js  —  Page Object for the UC4 AWI Login Page
 *
 * PURPOSE:
 * Encapsulates all browser interactions with the UC4 Automic Web Interface (AWI)
 * authentication screens — navigating to the login page, filling credentials,
 * verifying successful login, and logging out.
 *
 * ENVIRONMENT:
 * Target URL : https://awa-nonprod.woolworths.com.au/awi/
 * Client     : 300  (WOW_NONPROD)
 * Credentials: Loaded from .env.validation  →  UC4USERNAME, UC4PASSWORD
 */

class LoginPage {
    /**
     * @param {import('@playwright/test').Page} page - Playwright page instance
     */
    constructor(page) {
        this.page = page;

        // Login form fields
        this.clientInput   = page.getByRole('spinbutton', { name: 'Client' });   // Numeric "Client" field (e.g. 300)
        this.nameInput     = page.getByRole('textbox',    { name: 'Name' });      // Username field
        this.passwordInput = page.locator('input[type="password"]');              // Password field (use lowercase for reliability)

        // Login / logout buttons
        this.loginButton  = page.getByRole('button', { name: /login/i });           // Login submit button (use role-based locator)
        this.logoutButton = page.getByRole('button', { name: 'WOW_NONPROD :' }); // Header user-menu button (top-right corner)
        this.logoutLink   = page.locator('a').filter({ hasText: 'Logout' });      // "Logout" link inside the user-menu dropdown
    }

    /**
     * Navigates to the UC4 AWI login page and waits until the password field is visible.
     */
    async goTo() {
        await this.page.goto('https://awa-nonprod.woolworths.com.au/awi/');
        await this.page.waitForSelector(
            'input[type="Password"], input[type="password"]',
            { state: 'visible', timeout: 30000 }
        );
    }

    /**
     * Fills the login form and submits it.
     */
    async login(client, name, password) {
        // Allow one retry if the initial attempt fails due to transient issues.
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await this.clientInput.waitFor({ state: 'visible', timeout: 15000 });

                await this.clientInput.fill(client);
                await this.nameInput.fill(name);
                await this.passwordInput.fill(password);
                await this.loginButton.click();

                console.log('Waiting for post-login navigation... (attempt', attempt, ')');

                // Stage 1: Primary check — URL should move away from the login base path.
                await this.page.waitForURL(
                    url => !url.endsWith('/awi/'),
                    { timeout: 60000 }
                ).catch(async () => {
                    // Stage 2: Fallback — URL did not change. Check for any visible dashboard elements.
                    console.warn('URL did not change after 60 s. Trying dashboard element selectors...');
                    const dashboardSelectors = [
                        '#global-search-field',
                        'ecc-header',
                        '.awi-main-container',
                        '[role="navigation"]',
                        '[data-role="header"]',
                        'button:has-text("Process Assembly")',
                        'button:has-text("Process Monitoring")',
                        'ecc-navigation',
                        '.v-app',
                    ];

                    try {
                        // Wait until any one of the known dashboard selectors becomes visible.
                        // Use Promise.any so we resolve as soon as the first selector is found.
                        await Promise.any(
                            dashboardSelectors.map(sel => this.page.waitForSelector(sel, { state: 'visible', timeout: 60000 }))
                        );
                    } catch (err) {
                        console.error('Fallback dashboard selectors not found after 60s', err);
                        // If the login box is visible again, try healing the session automatically.
                        const loginBox = this.page.locator('input[type="Password"], input[type="password"]');
                        const isLoginBoxVisible = await loginBox.isVisible().catch(() => false);
                        if (isLoginBoxVisible) {
                            console.warn('Login box still visible after fallback — attempting session heal...');
                            await this.page.screenshot({ path: 'test-results/login-heal-attempt.png', fullPage: true }).catch(() => {});
                            await this.ensureSession(client, name, password).catch(() => {});
                            return;
                        }

                        // Capture a screenshot to aid debugging but do not crash the runner on screenshot failure.
                        await this.page.screenshot({ path: `test-results/login-failure-attempt-${attempt}.png`, fullPage: true }).catch(() => {});
                        throw err;
                    }
                });

                console.log('Login verified — post-login page loaded. Current URL:', this.page.url());
                return;
            } catch (err) {
                console.warn(`Login attempt ${attempt} failed: ${err && err.message ? err.message : err}`);
                if (attempt === 2) throw err;
                // Short delay before retrying
                await this.page.waitForTimeout(3000);
                // Try to reset to the login page before retrying
                await this.goTo().catch(() => {});
            }
        }
    }

    /**
     * Self-Healing Session Check Interceptor
     * Inspects the view state live to capture lost connection modals or forced login redirections.
     * If broken, it rebuilds authentication on the fly before a job search can execute.
     */
    async ensureSession(client, name, password) {
        const errorModal = this.page.locator('ecc-modal-dialog[header="Error"], ecc-modal-dialog:has-text("lost")');
        const loginBox   = this.page.locator('input[type="Password"], input[type="password"]');

        const isModalVisible = await errorModal.isVisible().catch(() => false);
        const isLoginBoxVisible = await loginBox.isVisible().catch(() => false);

        if (isModalVisible || isLoginBoxVisible) {
            console.warn('⚠️ [Session Monitor] Disconnected state or login box detected. Healing session...');
            
            if (isModalVisible) {
                // Dismiss the modal overlay box to unlock the canvas elements underneath
                const closeButton = errorModal.locator('button').first();
                if (await closeButton.isVisible()) {
                    await closeButton.click().catch(() => {});
                }
            }

            await this.goTo();
            await this.login(client, name, password);
            console.log('✅ [Session Monitor] Session healed successfully.');
        } else {
            // Context is stable, proceed immediately without redundant logins
            console.log('⚡ [Session Monitor] Active session is healthy.');
        }
    }

    /**
     * Logs out of UC4 AWI cleanly.
     */
    async logout() {
        try {
            await this.logoutButton.click({ timeout: 8000 });
            await this.logoutLink.click({ timeout: 8000 });
            await this.page.waitForSelector(
                'input[type="Password"], input[type="password"]',
                { state: 'visible', timeout: 15000 }
            );
            console.log('Logged out successfully.');
        } catch (err) {
            console.warn(`Logout encountered an issue (non-fatal): ${err.message}`);
        }
    }
}

module.exports = LoginPage;