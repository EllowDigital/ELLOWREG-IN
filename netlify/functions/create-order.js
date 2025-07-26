// /netlify/functions/create-order.js

// --- Dependencies ---
const Razorpay = require("razorpay");
const { sheets, retryWithBackoff } = require("./utils");

// --- Constants ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const ORDER_AMOUNT = 100; // The amount in the smallest currency unit (e.g., 100 paise = ₹1).
const RECEIPT_PREFIX = "receipt_order_";

// --- Service Initializations ---
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
                range: `${SHEET_NAME}!A:Z`, // Fetch all columns to build a complete object.
            })
        );

        const rows = sheetData.data.values || [];

        if (rows.length > 0) {
            const headers = rows[0].map(h => h.trim());
            const phoneColumnIndex = headers.findIndex(h => h.toLowerCase() === 'phone');

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
                // BUG FIX: This new logic is robust and will not crash.
                // It dynamically creates an object based on your sheet's headers.
                const registrationObject = headers.reduce((obj, header, index) => {
                    const key = (header.charAt(0).toLowerCase() + header.slice(1)).replace(/\s+/g, '');
                    obj[key] = existingRow[index] || ''; // Use empty string as a safe default.
                    return obj;
                }, {});

                return {
                    statusCode: 409, // Conflict
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: "This phone number is already registered.",
                        registrationData: {
                            registrationId: registrationObject.registrationId,
                            name: registrationObject.name,
                            phone: registrationObject.phone,
                            firmName: registrationObject.firmName,
                            attendance: registrationObject.attendance,
                            profileImageUrl: registrationObject.profileImageUrl,
                        },
                    }),
                };
            }
        }

        // If the user is new, create a new Razorpay order.
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
        console.error("CREATE_ORDER_ERROR:", err);
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
