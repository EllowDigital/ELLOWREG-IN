// /netlify/functions/list-registrations.js

const { pool } = require("./utils");

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

exports.handler = async (event) => {
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;

  if (!providedKey || providedKey !== secretKey) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const params = event.queryStringParameters || {};
  const parsedPage = parseInt(params.page, 10);
  const parsedLimit = parseInt(params.limit, 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const requestedLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedLimit, MAX_PAGE_SIZE);
  let dbClient;
  try {
    dbClient = await pool.connect();

    const { rows: countRows } = await dbClient.query(
      "SELECT COUNT(*) AS total FROM registrations",
    );

    const total = parseInt(countRows[0].total, 10) || 0;
    const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
    const safePage = Math.min(Math.max(page, 1), totalPages);
    const offset = (safePage - 1) * pageSize;

    const { rows: registrationRows } = await dbClient.query(
      `SELECT id, registration_id, name, phone, email, city, state, payment_id, timestamp, checked_in_at
         FROM registrations
         ORDER BY timestamp DESC
         LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        results: registrationRows,
        total,
        page: safePage,
        pageSize,
        totalPages,
      }),
    };
  } catch (error) {
    console.error("Error in list-registrations function:", error);
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
