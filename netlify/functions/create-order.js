// /netlify/functions/create-order.js
const Razorpay = require("razorpay");
const { google } = require("googleapis");

// Constants
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const PHONE_COLUMN_INDEX = 4; // Column E
const ORDER_AMOUNT = 100; // ₹1 in paise
const RECEIPT_PREFIX = "receipt_order_";

// Setup Google Sheets Auth
const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Retry Helper (for Sheets & Razorpay)
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay * 2 ** i));
            } else {
                throw err;
            }
        }
    }
};

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: "Method Not Allowed" }),
        };
    }

    try {
        const { phone } = JSON.parse(event.body || "{}");

        if (!phone || !/^\d{10}$/.test(phone.trim())) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Valid 10-digit phone number is required." }),
            };
        }

        // Step 1: Check if phone already registered
        const sheetData = await retryWithBackoff(() =>
            sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME}!A2:K1000`,
            })
        );

        const rows = sheetData.data.values || [];
        const existingRow = rows.find(row => row[PHONE_COLUMN_INDEX] === phone.trim());

        if (existingRow) {
            const [
                timestamp, registrationId, name, firmName, phoneNum,
                address, district, state, attendance, razorpayId, profileImageUrl
            ] = existingRow;

            return {
                statusCode: 409,
                body: JSON.stringify({
                    error: "Phone number is already registered.",
                    registrationData: {
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

        // Step 2: Create Razorpay order
        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

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
            body: JSON.stringify({
                error: "Failed to create Razorpay order. Please try again.",
                details: err.message,
            }),
        };
    }
};
