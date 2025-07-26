// /netlify/functions/create-order.js

const Razorpay = require("razorpay");
const { pool, retryWithBackoff } = require("./utils");

// --- Constants ---
const ORDER_AMOUNT = 100; // The amount in the smallest currency unit (e.g., 100 paise = ₹1).
const RECEIPT_PREFIX = "receipt_order_";

// --- Main Handler Function ---
exports.handler = async (event) => {
  // 1. Ensure the request is a POST request
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405, // Method Not Allowed
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  let dbClient;
  try {
    // Initialize Razorpay client
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    // 2. Parse and validate the incoming phone number from the JSON body
    const { phone } = JSON.parse(event.body || "{}");

    if (!phone || !/^[6-9]\d{9}$/.test(phone.trim())) {
      return {
        statusCode: 400, // Bad Request
        body: JSON.stringify({ error: "A valid 10-digit phone number is required." }),
      };
    }
    const trimmedPhone = phone.trim();

    // --- 3. Database Check ---
    // This block checks if the user has already registered.
    console.log(`[create-order] Checking database for phone: ${trimmedPhone}`);
    dbClient = await pool.connect();
    const existingUserQuery = 'SELECT registration_id, name, phone, company, day, image_url FROM registrations WHERE phone = $1';
    const { rows } = await dbClient.query(existingUserQuery, [trimmedPhone]);

    if (rows.length > 0) {
      // If a record is found, it means the user is already registered.
      // Return a 409 Conflict status along with their existing data.
      const registrationData = {
        registrationId: rows[0].registration_id,
        name: rows[0].name,
        phone: rows[0].phone,
        firmName: rows[0].company,
        attendance: rows[0].day,
        profileImageUrl: rows[0].image_url,
      };
      console.log(`[create-order] User with phone ${trimmedPhone} already exists. ID: ${registrationData.registrationId}`);
      return {
        statusCode: 409, // Conflict
        body: JSON.stringify({
          error: "This phone number is already registered.",
          registrationData: registrationData,
        }),
      };
    }

    // --- 4. Razorpay Order Creation ---
    console.log(`[create-order] Creating Razorpay order for new user: ${trimmedPhone}`);
    const orderOptions = {
      amount: ORDER_AMOUNT,
      currency: "INR",
      receipt: `${RECEIPT_PREFIX}${Date.now()}_${trimmedPhone}`,
    };

    const order = await retryWithBackoff(() => razorpay.orders.create(orderOptions));
    console.log(`[create-order] Razorpay order created successfully: ${order.id}`);

    // --- 5. Send Order and Public Key to Frontend ---
    // This is the key change: we send the public key along with the order details.
    const responsePayload = {
      ...order,
      key: process.env.RAZORPAY_KEY_ID
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responsePayload),
    };

  } catch (err) {
    // This will catch errors from JSON parsing or Razorpay API calls.
    console.error("CREATE_ORDER_ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "An internal server error occurred while creating the order.",
        details: err.message, // This detail is helpful for debugging in Netlify logs
      }),
    };
  } finally {
    if (dbClient) {
      dbClient.release();
    }
  }
};
