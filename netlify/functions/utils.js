// /netlify/functions/utils.js

const { Pool } = require('pg');
const { google } = require('googleapis');


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 15, // Increased pool size for handling concurrent function invocations
    connectionTimeoutMillis: 5000, // 5 seconds
    idleTimeoutMillis: 30000, // 30 seconds
    ssl: {
        rejectUnauthorized: false,
    },
});

// Optional: Add event listeners for logging and debugging pool activity
pool.on('connect', (client) => {
    console.log(`[DB_POOL] Client connected. Total clients: ${pool.totalCount}, Idle: ${pool.idleCount}`);
});
pool.on('error', (err, client) => {
    console.error('[DB_POOL] Unexpected error on idle client', err);
    process.exit(-1); // Exit the process to allow the serverless environment to restart it
});


/**
 * --- GOOGLE SHEETS API CLIENT ---
 *
 * A singleton container for the Google Sheets API client.
 * This pattern ensures that we only authenticate and create the client once
 * per container instance, which significantly improves the performance of
 * functions that interact with Google Sheets.
 */
let sheetsClient = null;

/**
 * Creates and returns an authenticated Google Sheets API client.
 * It uses a singleton pattern to reuse the client across function invocations
 * within the same container, avoiding redundant authentication.
 *
 * @returns {Promise<import('googleapis').sheets_v4.Sheets>} An authenticated Google Sheets API v4 client.
 * @throws {Error} If the GOOGLE_CREDENTIALS environment variable is missing or invalid.
 */
const getGoogleSheetsClient = async () => {
    if (sheetsClient) {
        return sheetsClient; // Return existing client if already authenticated
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
        console.error("[G_SHEETS_AUTH_ERROR] Failed to authenticate with Google Sheets:", error.message);
        // Re-throw a more user-friendly error to be caught by the calling function
        throw new Error("Could not create Google Sheets client. Please check credentials.");
    }
};

/**
 * --- GENERIC UTILITIES ---
 */

/**
 * A robust retry utility that re-attempts an asynchronous function upon failure.
 * It uses exponential backoff to increase the delay between retries, which helps
 * manage rate limits and temporary network or API issues.
 *
 * @template T
 * @param {() => Promise<T>} fn The asynchronous function to execute.
 * @param {string} operationName A descriptive name of the operation for logging purposes.
 * @param {number} [retries=3] The maximum number of retries.
 * @param {number} [delay=1000] The initial delay in milliseconds.
 * @returns {Promise<T>} The result of the successful function execution.
 * @throws The error from the last failed attempt.
 */
const retryWithBackoff = async (fn, operationName, retries = 3, delay = 1000) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn(); // Attempt the operation
        } catch (err) {
            if (attempt === retries) {
                console.error(`[RETRY_FAILED] Operation '${operationName}' failed after ${retries} attempts. Last error:`, err.message);
                throw err; // If it's the last attempt, throw the error
            }
            const waitTime = delay * 2 ** (attempt - 1); // Exponential backoff calculation
            console.warn(
                `[RETRYING] Operation '${operationName}' failed on attempt ${attempt}. Retrying in ${waitTime}ms... Error: ${err.message}`
            );
            await new Promise(res => setTimeout(res, waitTime)); // Wait before the next attempt
        }
    }
};

module.exports = {
    pool,
    getGoogleSheetsClient,
    retryWithBackoff
};
