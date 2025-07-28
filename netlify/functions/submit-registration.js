// /netlify/functions/submit-registration.js

const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");
const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Constants ---
const CLOUDINARY_FOLDER = "expo-profile-images-2025";
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";

// --- Cloudinary Configuration ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Parses a multipart/form-data request, properly handling multiple values for checkboxes.
 * @param {object} event The Netlify function event object.
 * @returns {Promise<{fields: object, files: object}>} The parsed form fields and files.
 */
const parseMultipartForm = (event) => new Promise((resolve, reject) => {
  const contentType = event.headers["content-type"] || event.headers["Content-Type"];
  if (!contentType) {
    return reject(new Error("Request is missing 'Content-Type' header."));
  }

  const bb = busboy({
    headers: { "content-type": contentType },
    limits: { fileSize: 5 * 1024 * 1024 }
  });

  const fields = {};
  const files = {};
  const attendanceDays = [];

  bb.on("file", (name, file, info) => {
    const chunks = [];
    file.on("data", (chunk) => chunks.push(chunk));
    file.on("limit", () => reject(new Error(`File '${info.filename}' exceeds the 5MB limit.`)));
    file.on("end", () => {
      files[name] = {
        filename: info.filename,
        content: Buffer.concat(chunks),
        contentType: info.mimeType,
      };
    });
  });

  bb.on("field", (name, value) => {
    if (name === 'attendance') {
      attendanceDays.push(value);
    } else {
      fields[name] = value;
    }
  });

  bb.on("close", () => {
    if (attendanceDays.length > 0) {
      fields.attendance = attendanceDays.join(', ');
    }
    resolve({ fields, files });
  });

  bb.on("error", (err) => reject(new Error(`Error parsing form data: ${err.message}`)));
  bb.end(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary"));
});

/**
 * Uploads a file buffer to Cloudinary.
 * @param {Buffer} buffer The file content as a Buffer.
 * @param {string} folder The Cloudinary folder to upload to.
 * @returns {Promise<object>} The Cloudinary upload result.
 */
const uploadToCloudinary = (buffer, folder) => new Promise((resolve, reject) => {
  const uploadStream = cloudinary.uploader.upload_stream(
    { folder, resource_type: "auto" },
    (err, result) => {
      if (err) return reject(new Error(`Cloudinary upload failed: ${err.message}`));
      if (!result) return reject(new Error("Cloudinary returned an empty result."));
      resolve(result);
    }
  );
  uploadStream.end(buffer);
});


// --- Main Handler Function ---
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let dbClient;
  try {
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage } = files;

    const trimmedPhone = phone ? phone.trim() : '';

    // Check for existing user first
    dbClient = await pool.connect();
    const existingUserQuery = 'SELECT registration_id, name, phone, company, day, image_url FROM registrations WHERE phone = $1';
    const { rows } = await dbClient.query(existingUserQuery, [trimmedPhone]);

    if (rows.length > 0) {
      // **BUG FIX:** The `dbClient.release()` call was removed from this block.
      // Releasing the client here and also in the `finally` block causes a
      // "double release" error, which crashes the function and results in a 502 error.
      // The `finally` block is the single source of truth for releasing the client.
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
          status: "exists",
          error: "This phone number is already registered.",
          registrationData: registrationData,
        }),
      };
    }

    // Validation for new registration
    if (!name || !trimmedPhone || !firmName || !profileImage || !attendance) {
      return { statusCode: 400, body: JSON.stringify({ status: "error", error: "Missing required fields." }) };
    }

    // Upload image to Cloudinary
    const uploadResult = await retryWithBackoff(() =>
      uploadToCloudinary(profileImage.content, CLOUDINARY_FOLDER), 'Cloudinary Upload'
    );

    const registrationId = `TDEXPOUP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const registrationTimestamp = new Date();

    // Insert new record into the database
    const insertQuery = `
            INSERT INTO registrations (registration_id, name, company, phone, address, city, state, day, payment_id, image_url, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *;`;
    const values = [
      registrationId, name.trim(), firmName.trim(), trimmedPhone, address.trim(),
      district.trim(), state.trim(), attendance, null,
      uploadResult.secure_url, registrationTimestamp
    ];
    const result = await dbClient.query(insertQuery, values);
    const newRecord = result.rows[0];

    // Background sync to Google Sheets
    (async () => {
      try {
        const sheets = await getGoogleSheetsClient();
        const newRowData = [
          newRecord.registration_id, newRecord.name, newRecord.company, newRecord.phone,
          newRecord.address, newRecord.city, newRecord.state, newRecord.day,
          newRecord.payment_id || 'N/A',
          new Date(newRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          newRecord.image_url,
        ];
        await retryWithBackoff(() => sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A1`,
          valueInputOption: "USER_ENTERED",
          resource: { values: [newRowData] },
        }), 'Google Sheets Sync');
        console.log(`Successfully synced registration ${newRecord.registration_id} to Google Sheets.`);
      } catch (sheetsError) {
        console.error(`CRITICAL: FAILED to sync registration ${newRecord.registration_id} to Google Sheets.`, sheetsError);
      }
    })();

    // Success response
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId: newRecord.registration_id,
          name: newRecord.name,
          phone: newRecord.phone,
          firmName: newRecord.company,
          attendance: newRecord.day,
          profileImageUrl: newRecord.image_url,
        },
      }),
    };

  } catch (err) {
    console.error("SUBMIT_REGISTRATION_ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "An internal server error occurred. Please try again.",
        details: err.message,
      }),
    };
  } finally {
    // This `finally` block is the single, guaranteed place where the client is released.
    // It runs regardless of whether the function returns successfully or throws an error.
    if (dbClient) {
      dbClient.release();
    }
  }
};
