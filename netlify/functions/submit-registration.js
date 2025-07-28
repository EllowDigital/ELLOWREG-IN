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
  const bb = busboy({ headers: { "content-type": contentType }, limits: { fileSize: 5 * 1024 * 1024 } });
  const fields = {};
  const files = {};
  const attendanceDays = [];
  bb.on("file", (name, file, info) => {
    const chunks = [];
    file.on("data", (chunk) => chunks.push(chunk));
    file.on("limit", () => reject(new Error(`File '${info.filename}' exceeds the 5MB limit.`)));
    file.on("end", () => {
      files[name] = { filename: info.filename, content: Buffer.concat(chunks), contentType: info.mimeType };
    });
  });
  bb.on("field", (name, value) => {
    if (name === 'attendance') { attendanceDays.push(value); } else { fields[name] = value; }
  });
  bb.on("close", () => {
    if (attendanceDays.length > 0) { fields.attendance = attendanceDays.join(', '); }
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
  const uploadStream = cloudinary.uploader.upload_stream({ folder, resource_type: "auto" }, (err, result) => {
    if (err) return reject(new Error(`Cloudinary upload failed: ${err.message}`));
    if (!result) return reject(new Error("Cloudinary returned an empty result."));
    resolve(result);
  });
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

    // --- Step 1: Check for existing user in the primary database (Neon) ---
    dbClient = await pool.connect();
    const existingUserQuery = 'SELECT * FROM registrations WHERE phone = $1';
    const { rows } = await dbClient.query(existingUserQuery, [trimmedPhone]);

    if (rows.length > 0) {
      // If user exists in DB, they are already registered. Return conflict.
      const registrationData = {
        registrationId: rows[0].registration_id, name: rows[0].name, phone: rows[0].phone,
        firmName: rows[0].company, attendance: rows[0].day, profileImageUrl: rows[0].image_url,
      };
      return {
        statusCode: 409, // Conflict
        body: JSON.stringify({ status: "exists", error: "This phone number is already registered.", registrationData }),
      };
    }

    // --- Step 2: Validate new registration data ---
    if (!name || !trimmedPhone || !firmName || !profileImage || !attendance) {
      return { statusCode: 400, body: JSON.stringify({ status: "error", error: "Missing required fields." }) };
    }

    // --- Step 3: Register New User in Primary Database (Neon) ---
    const uploadResult = await retryWithBackoff(() => uploadToCloudinary(profileImage.content, CLOUDINARY_FOLDER), 'Cloudinary Upload');
    const registrationId = `TDEXPOUP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const registrationTimestamp = new Date();
    const insertQuery = `INSERT INTO registrations (registration_id, name, company, phone, address, city, state, day, payment_id, image_url, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;`;
    const values = [registrationId, name.trim(), firmName.trim(), trimmedPhone, address.trim(), district.trim(), state.trim(), attendance, null, uploadResult.secure_url, registrationTimestamp];
    const result = await dbClient.query(insertQuery, values);
    const newRecord = result.rows[0];

    // --- Step 4: Perform LIVE Sync with Google Sheets to handle updates/inserts ---
    console.log(`Live syncing registration ${newRecord.registration_id} to Google Sheets...`);
    try {
      const sheets = await getGoogleSheetsClient();
      // Fetch only the phone number column for efficiency
      const sheetResponse = await retryWithBackoff(() => sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!D:D` }), 'Google Sheets Get Phones');
      const phoneColumn = sheetResponse.data.values || [];

      // Find the row index of the matching phone number.
      let targetRowIndex = -1;
      for (let i = 0; i < phoneColumn.length; i++) {
        if (phoneColumn[i][0] === newRecord.phone) {
          // Sheet row numbers are 1-based.
          targetRowIndex = i + 1;
          break;
        }
      }

      const newRowData = [
        newRecord.registration_id, newRecord.name, newRecord.company, newRecord.phone,
        newRecord.address, newRecord.city, newRecord.state, newRecord.day,
        newRecord.payment_id || 'N/A',
        new Date(newRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        newRecord.image_url,
      ];

      if (targetRowIndex !== -1) {
        // Phone found: Update the existing row to prevent duplicates.
        console.log(`Phone ${newRecord.phone} found in Sheet at row ${targetRowIndex}. Updating.`);
        await retryWithBackoff(() => sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${targetRowIndex}`,
          valueInputOption: "USER_ENTERED", resource: { values: [newRowData] },
        }), 'Google Sheets Update');
      } else {
        // Phone not found: Append a new row for the new user.
        console.log(`Phone ${newRecord.phone} not found in Sheet. Appending new row.`);
        await retryWithBackoff(() => sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1`,
          valueInputOption: "USER_ENTERED", resource: { values: [newRowData] },
        }), 'Google Sheets Append');
      }
      console.log(`Successfully live synced registration ${newRecord.registration_id}.`);
    } catch (sheetsError) {
      // If live sync fails, log it. The scheduled sync job will eventually correct it.
      console.error(`CRITICAL: LIVE sync to Google Sheets failed for ${newRecord.registration_id}. The scheduled sync will fix this later.`, sheetsError);
    }

    // --- Step 5: Return Success to the User ---
    return {
      statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId: newRecord.registration_id, name: newRecord.name, phone: newRecord.phone,
          firmName: newRecord.company, attendance: newRecord.day, profileImageUrl: newRecord.image_url,
        },
      }),
    };

  } catch (err) {
    console.error("SUBMIT_REGISTRATION_ERROR:", err);
    return {
      statusCode: 500, body: JSON.stringify({ status: "error", error: "An internal server error occurred. Please try again.", details: err.message }),
    };
  } finally {
    // This is the single, guaranteed place the client is released back to the pool.
    if (dbClient) {
      dbClient.release();
    }
  }
};
