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
                // Fetch all columns to ensure we can build a complete object.
                range: `${SHEET_NAME}!A:Z`,
            })
        );

        const rows = sheetData.data.values || [];

        if (rows.length > 0) {
            // Get header row and find the phone column dynamically.
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
                // FINAL FIX: Create a robust object from the row data and headers.
                // This is not brittle and will not break if you reorder columns in your Google Sheet.
                const registrationObject = headers.reduce((obj, header, index) => {
                    // Convert header to a camelCase key (e.g., "Firm Name" -> "firmName")
                    const key = (header.charAt(0).toLowerCase() + header.slice(1)).replace(/\s+/g, '');
                    obj[key] = existingRow[index] || ''; // Use empty string as a safe default.
                    return obj;
                }, {});

                return {
                    statusCode: 409, // Conflict
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: "This phone number is already registered.",
                        // Pass the structured object to the frontend.
                        // The keys here (e.g., registrationId) must match what the frontend expects.
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
