// /netlify/functions/create-order.js

const Razorpay = require("razorpay");
const { pool, retryWithBackoff } = require("./utils");

// --- Constants ---
const ORDER_AMOUNT = 100; // ₹1 in paise
const RECEIPT_PREFIX = "receipt_order_";

// --- Razorpay Initialization ---
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- Main Lambda Handler ---
exports.handler = async (event) => {
  // 1. Allow only POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let dbClient;
  try {
    // 2. Parse and validate phone number
    const { phone } = JSON.parse(event.body || "{}");

    if (!phone || !/^[6-9]\d{9}$/.test(phone.trim())) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "A valid 10-digit phone number is required." }),
      };
    }

    const trimmedPhone = phone.trim();

    // 3. Check if phone number already registered
    dbClient = await pool.connect();
    const query = `
      SELECT registration_id, name, phone, company, day, image_url 
      FROM registrations 
      WHERE phone = $1
    `;
    const { rows } = await dbClient.query(query, [trimmedPhone]);

    if (rows.length > 0) {
      const user = rows[0];
      return {
        statusCode: 409, // Conflict
        body: JSON.stringify({
          error: "This phone number is already registered.",
          registrationData: {
            registrationId: user.registration_id,
            name: user.name,
            phone: user.phone,
            firmName: user.company,
            attendance: user.day,
            profileImageUrl: user.image_url,
          },
        }),
      };
    }

    // 4. Create Razorpay Order
    const orderOptions = {
      amount: ORDER_AMOUNT,
      currency: "INR",
      receipt: `${RECEIPT_PREFIX}${Date.now()}_${trimmedPhone}`,
    };

    const order = await retryWithBackoff(() => razorpay.orders.create(orderOptions));

    // 5. Send order details and public Razorpay key to frontend
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...order,
        key: process.env.RAZORPAY_KEY_ID,
      }),
    };

  } catch (err) {
    console.error("[create-order] ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error while creating the order.",
        details: err.message,
      }),
    };
  } finally {
    if (dbClient) dbClient.release();
  }
};
