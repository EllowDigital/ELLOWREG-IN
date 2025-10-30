// /netlify/functions/delete-registration.js

const { pool } = require("./utils");

exports.handler = async (event) => {
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;

  if (!providedKey || providedKey !== secretKey) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  if (event.httpMethod !== "DELETE") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON payload." }),
    };
  }

  const { registrationId } = payload;
  if (!registrationId || typeof registrationId !== "string") {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "registrationId is required." }),
    };
  }

  const normalizedRegistrationId = registrationId.trim().toUpperCase();

  let dbClient;
  try {
    dbClient = await pool.connect();
    const { rows } = await dbClient.query(
      `DELETE FROM registrations WHERE registration_id = $1 RETURNING registration_id, name;`,
      [normalizedRegistrationId],
    );

    if (rows.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Registration not found." }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Registration deleted successfully.",
        registrationId: rows[0].registration_id,
      }),
    };
  } catch (error) {
    console.error("Error in delete-registration function:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An internal server error occurred." }),
    };
  } finally {
    if (dbClient) {
      dbClient.release();
    }
  }
};
