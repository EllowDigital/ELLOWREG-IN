// /netlify/functions/utils.js

const { Pool } = require('pg');
const { google } = require('googleapis');

/**
 * --- DATABASE CONNECTION POOL ---
 *
 * A robust, serverless-friendly PostgreSQL connection pool.
 * This configuration is essential for reliability in a serverless environment.
 */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 15, // Max concurrent clients
    // CRITICAL: Increased timeout to handle serverless cold starts without failing.
    connectionTimeoutMillis: 15000, // 15 seconds
    idleTimeoutMillis: 30000,       // 30 seconds
    ssl: {
        // This is often required by managed database providers.
        // For production, ensure you are using a valid CA-signed certificate.
        rejectUnauthorized: false,
    },
});

// Optional: Add event listeners for logging and debugging pool activity
pool.on('error', (err, client) => {
    console.error('[DB_POOL] Unexpected error on idle client', err);
    process.exit(-1); // A harsh but effective way to force a container restart on critical error.
});

/**
 * --- GOOGLE SHEETS API CLIENT ---
 *
 * A singleton container for the Google Sheets API client to ensure we only
 * authenticate once per container instance, improving performance.
 */
let sheetsClient = null;

const getGoogleSheetsClient = async () => {
    if (sheetsClient) {
        return sheetsClient; // Return existing client
    }
    try {
        if (!process.env.GOOGLE_CREDENTIALS) {
            throw new Error("GOOGLE_CREDENTIALS environment variable is not set.");
        }
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const authClient = await auth.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        console.log("[G_SHEETS] Google Sheets client authenticated successfully.");
        return sheetsClient;
    } catch (error) {
        console.error("[G_SHEETS_AUTH_ERROR] Failed to authenticate:", error.message);
        throw new Error("Could not create Google Sheets client. Please check credentials.");
    }
};

/**
 * --- GENERIC RETRY UTILITY ---
 *
 * A robust retry utility with exponential backoff for making network requests
 * to external APIs more reliable.
 */
const retryWithBackoff = async (fn, operationName, retries = 3, delay = 1000) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries) {
                console.error(`[RETRY_FAILED] Operation '${operationName}' failed after ${retries} attempts. Last error:`, err.message);
                throw err;
            }
            const waitTime = delay * 2 ** (attempt - 1);
            console.warn(
                `[RETRYING] Operation '${operationName}' failed on attempt ${attempt}. Retrying in ${waitTime}ms... Error: ${err.message}`
            );
            await new Promise(res => setTimeout(res, waitTime));
        }
    }
};

module.exports = {
    pool,
    getGoogleSheetsClient,
    retryWithBackoff
};