// /netlify/functions/create-order.js
const Razorpay = require('razorpay');
const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const PHONE_COLUMN = "E";

const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { phone } = JSON.parse(event.body || "{}");
        if (!phone) {
            return { statusCode: 400, body: JSON.stringify({ error: "Phone number is required." }) };
        }

        // Get all phone numbers and match
        const phoneRes = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A2:K`,
        });

        const rows = phoneRes.data.values || [];
        const matchRow = rows.find(row => row[4] === phone);

        if (matchRow) {
            const [
                timestamp, registrationId, name, firmName, phoneNum,
                address, district, state, attendance, razorpayId, profileImageUrl
            ] = matchRow;

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
                    }
                }),
            };
        }

        // Create Razorpay order
        const razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        const order = await razorpay.orders.create({
            amount: 100, // ₹1 for testing; use 50000 for ₹500
            currency: "INR",
            receipt: `receipt_order_${Date.now()}`,
        });

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(order),
        };

    } catch (err) {
        console.error("CREATE_ORDER_ERROR:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal server error during order creation." }),
        };
    }
};
