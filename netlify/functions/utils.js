const { Pool } = require('pg');
const { google } = require('googleapis');

/**
 * PostgreSQL connection pool.
 * It automatically uses the DATABASE_URL environment variable.
 * The pool manages multiple client connections efficiently.
 */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Required for connecting to cloud databases like Neon that use SSL
    ssl: {
        rejectUnauthorized: false
    }
});

/**
 * Creates and authenticates a Google Sheets API client.
 * @returns {Promise<sheets_v4.Sheets>} An authenticated Google Sheets API instance.
 */
const getGoogleSheetsClient = async () => {
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const authClient = await auth.getClient();
        return google.sheets({ version: 'v4', auth: authClient });
    } catch (error) {
        console.error("Error initializing Google Sheets client:", error);
        throw new Error("Could not authenticate with Google Sheets. Check GOOGLE_CREDENTIALS.");
    }
};

/**
 * Retries an asynchronous function with exponential backoff.
 * Useful for handling transient network or API errors.
 * @param {Function} fn The asynchronous function to execute.
 * @param {number} [retries=3] The maximum number of retries.
 * @param {number} [delay=500] The initial delay in milliseconds.
 * @returns {Promise<any>} The result of the successful function execution.
 */
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) {
                console.error(`Function failed after ${retries} retries.`, err);
                throw err;
            }
            const backoffDelay = delay * (2 ** i);
            console.log(`Attempt ${i + 1} failed. Retrying in ${backoffDelay}ms...`);
            await new Promise(res => setTimeout(res, backoffDelay));
        }
    }
};

module.exports = {
    pool,
    getGoogleSheetsClient,
    retryWithBackoff
};
