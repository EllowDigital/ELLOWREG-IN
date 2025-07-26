// /netlify/functions/create-order.js

// --- Dependencies ---
const Razorpay = require("razorpay");
// IMPROVEMENT: Import shared utilities instead of re-defining them.
// This assumes you have a 'utils.js' file in a 'lib' folder inside 'functions'.
const { sheets, retryWithBackoff } = require("./lib/utils");

// --- Constants ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const ORDER_AMOUNT = 100; // The amount in the smallest currency unit (e.g., 100 paise = ₹1).
const RECEIPT_PREFIX = "receipt_order_";

// --- Service Initializations ---

// Setup Razorpay client.
// Keys are read from environment variables for security.
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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

        if (!phone || !/^[6-9]\d{9}$/.test(phone.trim())) {
            return {
                statusCode: 400, // Bad Request
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "A valid 10-digit phone number is required." }),
            };
        }
        const trimmedPhone = phone.trim();

        // 3. Fetch all data from the Google Sheet using the imported 'sheets' client.
        // The range 'A:K' makes the function scalable to any number of registrations.
        const sheetData = await retryWithBackoff(() =>
            sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A:K`, // Fetches all data within columns A to K.
            })
        );

        const rows = sheetData.data.values || [];

        // 4. Dynamically find the column index for the phone number.
        const headers = rows[0] || [];
        const phoneColumnIndex = headers.findIndex(header => header.toLowerCase().trim() === 'phone');

        if (phoneColumnIndex === -1) {
            // If the 'phone' column is not found, it's a critical configuration error.
            console.error("Configuration Error: 'phone' column not found in Google Sheet.");
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "Server configuration error. Please contact support." }),
            };
        }

        // 5. Check if the phone number is already registered.
        // Search from the second row (index 1) to skip the header.
        const existingRow = rows.slice(1).find(row => row[phoneColumnIndex] === trimmedPhone);

        if (existingRow) {
            // If the user is already registered, return their data to prevent re-payment.
            const [
                timestamp, registrationId, name, firmName, phoneNum,
                address, district, state, attendance, razorpayId, profileImageUrl
            ] = existingRow;

            return {
                statusCode: 409, // Conflict
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: "This phone number is already registered.",
                    registrationData: { // Send existing data back to the client for immediate recovery.
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

        // 6. If the user is new, create a new Razorpay order.
        const order = await retryWithBackoff(() =>
            razorpay.orders.create({
                amount: ORDER_AMOUNT,
                currency: "INR",
                receipt: `${RECEIPT_PREFIX}${Date.now()}`,
            })
        );

        // 7. Return the successfully created order details to the client.
        return {
            statusCode: 200, // OK
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(order),
        };

    } catch (err) {
        // 8. Generic error handler for any unexpected issues.
        console.error("CREATE_ORDER_ERROR:", err.message || err);
        return {
            statusCode: 500, // Internal Server Error
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: "Failed to create the Razorpay order. Please try again later.",
                details: err.message,
            }),
        };
    }
};
