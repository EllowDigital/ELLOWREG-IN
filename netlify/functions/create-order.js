// /netlify/functions/create-order.js

// --- Dependencies ---
const Razorpay = require("razorpay");
// FIX: Corrected the path to import from the same directory.
const { sheets, retryWithBackoff } = require("./utils");

// --- Constants ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const ORDER_AMOUNT = 100; // The amount in the smallest currency unit (e.g., 100 paise = ₹1).
const RECEIPT_PREFIX = "receipt_order_";

// --- Service Initializations ---

// Setup Razorpay client.
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- Main Handler Function ---
exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Method Not Allowed" }),
        };
    }

    try {
        const { phone } = JSON.parse(event.body || "{}");
        if (!phone || !/^[6-9]\d{9}$/.test(phone.trim())) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "A valid 10-digit phone number is required." }),
            };
        }
        const trimmedPhone = phone.trim();

        const sheetData = await retryWithBackoff(() =>
            sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A:K`,
            })
        );

        const rows = sheetData.data.values || [];

        // If the sheet is not empty, perform the check for existing users.
        if (rows.length > 0) {
            const headers = rows[0] || [];
            const phoneColumnIndex = headers.findIndex(header => header.toLowerCase().trim() === 'phone');

            if (phoneColumnIndex === -1) {
                console.error("Configuration Error: 'phone' column not found in Google Sheet headers.");
                return {
                    statusCode: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: "Server configuration error. Please contact support." }),
                };
            }

            const existingRow = rows.slice(1).find(row => row[phoneColumnIndex] === trimmedPhone);

            if (existingRow) {
                const [
                    timestamp, registrationId, name, firmName, phoneNum,
                    address, district, state, attendance, razorpayId, profileImageUrl
                ] = existingRow;

                return {
                    statusCode: 409, // Conflict
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: "This phone number is already registered.",
                        registrationData: {
                            registrationId, name, phone: phoneNum, firmName,
                            attendance, profileImageUrl,
                        },
                    }),
                };
            }
        }

        // If the sheet was empty or the user was not found, create a new Razorpay order.
        const order = await retryWithBackoff(() =>
            razorpay.orders.create({
                amount: ORDER_AMOUNT,
                currency: "INR",
                receipt: `${RECEIPT_PREFIX}${Date.now()}`,
            })
        );

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(order),
        };

    } catch (err) {
        console.error("CREATE_ORDER_ERROR:", err.message || err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: "Failed to create the Razorpay order. Please try again later.",
                details: err.message,
            }),
        };
    }
};
