// /netlify/functions/create-order.js

// Import the Razorpay library
const Razorpay = require('razorpay');

exports.handler = async () => {
    // This securely initializes Razorpay using the keys you set in your Netlify dashboard.
    // The code reads 'RAZORPAY_KEY_ID' and 'RAZORPAY_KEY_SECRET' from the server environment.
    const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const options = {
        amount: 100, // Amount in paise (500 INR = 50000 paise)
        currency: "INR",
        receipt: `receipt_order_${new Date().getTime()}`, // Generates a unique receipt ID for each order
    };

    try {
        // Attempt to create a new order with Razorpay
        const order = await razorpay.orders.create(options);
        
        // If successful, return the order details to the frontend
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(order),
        };
    } catch (error) {
        // If there's an error (e.g., invalid keys, network issue), log it and return an error
        console.error("RAZORPAY_ORDER_ERROR:", error);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: "Could not create payment order." }) 
        };
    }
};
