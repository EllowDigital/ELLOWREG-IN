// /netlify/functions/get-change-token.js

const crypto = require("crypto");
const { pool } = require("./utils");

// Cache results briefly to avoid hammering the database when multiple admin tabs poll.
let cachedPayload = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 1000; // 10 seconds

let hasUpdatedAtColumn = null;

const detectUpdatedAtColumn = async (client) => {
  if (hasUpdatedAtColumn !== null) {
    return hasUpdatedAtColumn;
  }
  const checkQuery = `
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'registrations'
       AND column_name = 'updated_at'
     LIMIT 1;`;
  const { rowCount } = await client.query(checkQuery);
  hasUpdatedAtColumn = rowCount > 0;
  return hasUpdatedAtColumn;
};

exports.handler = async (event) => {
  const providedKey = event.headers["x-admin-key"];
  const secretKey = process.env.EXPORT_SECRET_KEY;

  if (!providedKey || providedKey !== secretKey) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  if (Date.now() - cachedAt < CACHE_TTL_MS && cachedPayload) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cachedPayload),
    };
  }

  let client;
  try {
    client = await pool.connect();
    const hasUpdatedAt = await detectUpdatedAtColumn(client);

    const baseQuery = `
      SELECT
        COUNT(*)::int AS total_rows,
        COALESCE(MAX(timestamp), '1970-01-01'::timestamp) AS last_created,
        COALESCE(MAX(checked_in_at), '1970-01-01'::timestamp) AS last_checkin,
        COALESCE(SUM(CASE WHEN needs_sync THEN 1 ELSE 0 END), 0)::int AS pending_sync
      ${hasUpdatedAt ? ", COALESCE(MAX(updated_at), '1970-01-01'::timestamp) AS last_update" : ""}
      FROM registrations;`;

    const { rows } = await client.query(baseQuery);
    const row = rows[0] || {};

    const lastCreatedISO = row.last_created
      ? new Date(row.last_created).toISOString()
      : "";
    const lastCheckinISO = row.last_checkin
      ? new Date(row.last_checkin).toISOString()
      : "";
    const lastUpdateISO =
      hasUpdatedAt && row.last_update
        ? new Date(row.last_update).toISOString()
        : "";

    const parts = [
      row.total_rows ?? 0,
      row.pending_sync ?? 0,
      lastCreatedISO,
      lastCheckinISO,
    ];
    if (hasUpdatedAt) {
      parts.push(lastUpdateISO);
    }

    const tokenSeed = parts.join("|");
    const token = crypto.createHash("sha1").update(tokenSeed).digest("hex");

    const timeCandidates = [lastCreatedISO, lastCheckinISO];
    if (hasUpdatedAt) {
      timeCandidates.push(lastUpdateISO);
    }
    const lastActivityISO =
      timeCandidates
        .filter((value) => Boolean(value))
        .sort()
        .pop() || null;

    const payload = {
      token,
      lastActivity: lastActivityISO,
      snapshot: {
        totalRows: row.total_rows ?? 0,
        pendingSync: row.pending_sync ?? 0,
      },
    };

    cachedPayload = payload;
    cachedAt = Date.now();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  } catch (error) {
    console.error("Error in get-change-token:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An internal server error occurred." }),
    };
  } finally {
    if (client) {
      client.release();
    }
  }
};
