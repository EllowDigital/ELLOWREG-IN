// /netlify/functions/admin-login.js

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { password } = JSON.parse(event.body);

    // Use the same key for login password and API authentication
    const secretKey = process.env.EXPORT_SECRET_KEY;

    // Check if the provided password matches your secret key
    if (password && password === secretKey) {
      // If correct, return the secret key to be used by the admin panel
      return {
        statusCode: 200,
        body: JSON.stringify({ secretKey: secretKey }),
      };
    } else {
      // If incorrect, return an unauthorized error
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Invalid password." }),
      };
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An internal error occurred." }),
    };
  }
};
