// /netlify/functions/update-registration.js

const { pool } = require("./utils");

const ALLOWED_FIELDS = ["name", "phone", "email", "city", "state"];

exports.handler = async (event) => {
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;

  if (!providedKey || providedKey !== secretKey) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  if (!["PUT", "PATCH"].includes(event.httpMethod)) {
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

  const normalize = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    return value;
  };

  const updates = {};
  for (const field of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      updates[field] = normalize(payload[field]);
    }
  }

  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "No updatable fields provided." }),
    };
  }

  const setClauses = [];
  const values = [];
  let index = 1;
  for (const field of updateKeys) {
    setClauses.push(`${field} = $${index}`);
    values.push(updates[field]);
    index += 1;
  }
  setClauses.push("updated_at = NOW()");
  setClauses.push("needs_sync = true");

  const normalizedRegistrationId = registrationId.trim().toUpperCase();
  values.push(normalizedRegistrationId);

  const updateQuery = `
    UPDATE registrations
       SET ${setClauses.join(", ")}
     WHERE registration_id = $${index}
     RETURNING id, registration_id, name, phone, email, city, state, payment_id, timestamp, checked_in_at;
  `;

  let dbClient;
  try {
    dbClient = await pool.connect();
    const { rows } = await dbClient.query(updateQuery, values);

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
        message: "Registration updated successfully.",
        record: rows[0],
      }),
    };
  } catch (error) {
    console.error("Error in update-registration function:", error);
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
