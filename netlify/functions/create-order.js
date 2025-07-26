// /netlify/functions/create-order.js
const Razorpay = require("razorpay");
const { pool, retryWithBackoff } = require("./utils");
const crypto = require("crypto");

// Constants
const ORDER_AMOUNT = 100; // The amount in the smallest currency unit (e.g., 100 paise = ₹1).
const RECEIPT_PREFIX = "receipt_order_";

// Initialize Razorpay client
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    try {
        const { phone } = JSON.parse(event.body || "{}");
        if (!phone || !/^[6-9]\d{9}$/.test(phone.trim())) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "A valid 10-digit phone number is required." }),
            };
        }
        const trimmedPhone = phone.trim();

        const dbClient = await pool.connect();
        try {
            // Check if user already exists
            const existingUserQuery = 'SELECT * FROM registrations WHERE phone = $1';
            const { rows } = await dbClient.query(existingUserQuery, [trimmedPhone]);

            if (rows.length > 0) {
                // User already registered, return their data
                const registrationData = {
                    registrationId: rows[0].registration_id,
                    name: rows[0].name,
                    phone: rows[0].phone,
                    firmName: rows[0].company,
                    attendance: rows[0].day,
                    profileImageUrl: rows[0].image_url,
                };

                return {
                    statusCode: 409, // Conflict
                    body: JSON.stringify({
                        error: "This phone number is already registered.",
                        registrationData: registrationData,
                    }),
                };
            }
        } finally {
            dbClient.release();
        }

        // If not registered, create a new Razorpay order
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
            body: JSON.stringify({
                error: "Failed to create the Razorpay order. Please try again later.",
                details: err.message,
            }),
        };
    }
};