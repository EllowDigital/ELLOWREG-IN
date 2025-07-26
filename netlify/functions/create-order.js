// /netlify/functions/create-order.js

// --- Dependencies ---
const Razorpay = require("razorpay");
const { google } = require("googleapis");

// --- Constants ---
// It's good practice to keep environment-dependent variables and fixed values at the top.
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations"; // The name of the sheet within your Google Sheet document.
const ORDER_AMOUNT = 100; // The amount in the smallest currency unit (e.g., 100 paise = ₹1).
const RECEIPT_PREFIX = "receipt_order_";

// --- Service Initializations ---

// Setup Google Sheets API client with authentication.
// The credentials are read from an environment variable for security.
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"], // Scope limited to read-only as this function only checks for data.
});
const sheets = google.sheets({ version: "v4", auth });

// Setup Razorpay client.
// Keys are read from environment variables for security.
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});


// --- Utility Functions ---
// NOTE: This helper function is excellent. In a larger project, you could move this
// and the service initializations to a shared '/lib' directory to avoid code duplication
// between your Netlify functions.

/**
 * Retries an asynchronous function with exponential backoff.
 * @param {Function} fn The asynchronous function to execute.
 * @param {number} retries The maximum number of retries.
 * @param {number} delay The initial delay in milliseconds.
 * @returns {Promise<any>} The result of the successful function execution.
 */
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            // If it's the last retry, throw the error.
            if (i === retries - 1) throw err;
            // Otherwise, wait for an exponentially increasing amount of time.
            await new Promise(res => setTimeout(res, delay * 2 ** i));
        }
    }
};

// --- Main Handler Function ---
exports.handler = async (event) => {
    // 1. Ensure the request is a POST request.
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405, // Method Not Allowed
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Method Not Allowed" }),
        };
    }

    try {
        // 2. Parse and validate the incoming request body.
        const { phone } = JSON.parse(event.body || "{}");

        if (!phone || !/^\d{10}$/.test(phone.trim())) {
            return {
                statusCode: 400, // Bad Request
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "A valid 10-digit phone number is required." }),
            };
        }
        const trimmedPhone = phone.trim();

        // 3. Fetch all data from the Google Sheet.
        // **IMPROVEMENT**: The range 'A:K' is used instead of a fixed range like 'A1:K1000'.
        // This makes the function scalable and ensures it works for any number of registrations.
        const sheetData = await retryWithBackoff(() =>
            sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A:K`, // Fetches all data within columns A to K.
            })
        );

        const rows = sheetData.data.values || [];

        // **IMPROVEMENT**: Dynamically find the column index for the phone number.
        // This makes the code resilient if columns are added, removed, or reordered in the sheet.
        const headers = rows[0] || [];
        const phoneColumnIndex = headers.findIndex(header => header.toLowerCase().trim() === 'phone');

        if (phoneColumnIndex === -1) {
            // If the 'phone' column is not found, it's a critical configuration error.
            console.error("Configuration Error: 'phone' column not found in Google Sheet.");
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "Server configuration error. Could not process registration check." }),
            };
        }

        // 4. Check if the phone number is already registered.
        // We start searching from the second row (index 1) to skip the header.
        const existingRow = rows.slice(1).find(row => row[phoneColumnIndex] === trimmedPhone);

        if (existingRow) {
            // If the user is already registered, return their data immediately.
            // This prevents them from paying again.
            const [
                timestamp, registrationId, name, firmName, phoneNum,
                address, district, state, attendance, razorpayId, profileImageUrl
            ] = existingRow;

            return {
                statusCode: 409, // Conflict
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: "This phone number is already registered.",
                    registrationData: { // Send existing data back to the client.
                        registrationId,
                        name,
                        phone: phoneNum,
                        firmName,
                        attendance,
                        profileImageUrl,
                    },
                }),
            };
        }

        // 5. If the user is new, create a new Razorpay order.
        const order = await retryWithBackoff(() =>
            razorpay.orders.create({
                amount: ORDER_AMOUNT,
                currency: "INR",
                receipt: `${RECEIPT_PREFIX}${Date.now()}`,
            })
        );

        // 6. Return the successfully created order details to the client.
        return {
            statusCode: 200, // OK
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(order),
        };

    } catch (err) {
        // 7. Generic error handler for any unexpected issues.
        console.error("CREATE_ORDER_ERROR:", err.message || err);
        return {
            statusCode: 500, // Internal Server Error
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: "Failed to create the Razorpay order. Please try again later.",
                details: err.message, // Provide detail for easier debugging.
            }),
        };
    }
};
