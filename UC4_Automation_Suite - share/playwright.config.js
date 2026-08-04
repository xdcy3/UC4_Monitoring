const { defineConfig, devices } = require('@playwright/test');
require('dotenv').config({ path: '.env.validation' });

/**
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests',

  // Individual test timeout — beforeEach/beforeAll uses this too unless overridden
  timeout : 120 * 1000,
  expect : {
    timeout : 3000
  },
  
  /* Run tests in files in parallel */
  fullyParallel: true,
  
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  
  /* FORCE PARALLEL WORKERS TO SPEED RUNTIME FROM 60 MINS TO < 20 MINS */
  workers: process.env.CI ? 1 : 1,
  
  /* PREVENT BACKGROUND RUN HANGS: Generates the report but never opens a blocking server window */
  reporter: 'html',
  
  /* Shared settings for all the projects below. */
  use: {
    /* Collect trace when retrying the failed test. */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});