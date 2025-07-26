// /netlify/functions/submit-registration.js

const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");
// Uses the shared database pool and Google Sheets client from utils.js
const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Constants ---
const CLOUDINARY_FOLDER = "expo-profile-images-2025";
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations"; // Ensure this sheet/tab name exists in your Google Sheet file

// --- Cloudinary Configuration ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// --- Utility Functions ---

/**
 * Parses a multipart/form-data request body from a Netlify function event.
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
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB file size limit
  });

  const fields = {};
  const files = {};

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

  bb.on("field", (name, value) => { fields[name] = value; });
  bb.on("close", () => resolve({ fields, files }));
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
      resolve(result);
    }
  );
  uploadStream.end(buffer);
});

// --- Main Handler Function ---
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let dbClient; // Define client here to be accessible in the finally block

  try {
    // 1. Parse multipart form data
    const { fields, files } = await parseMultipartForm(event);
    const {
      name, phone, firmName, address, district, state, attendance,
      razorpay_order_id, razorpay_payment_id, razorpay_signature
    } = fields;
    const { profileImage } = files;

    // 2. Security Check: Verify Razorpay signature
    const shasum = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest("hex");

    if (digest !== razorpay_signature) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid payment signature." }) };
    }

    // 3. Validate input fields
    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value || String(value).trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ status: "error", error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) {
      return { statusCode: 400, body: JSON.stringify({ status: "error", error: "A profile photo is required." }) };
    }

    // 4. Upload image to Cloudinary
    const uploadResult = await retryWithBackoff(() =>
      uploadToCloudinary(profileImage.content, CLOUDINARY_FOLDER)
    );

    // 5. Generate a unique Registration ID
    const registrationId = `TDEXPOUP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const registrationTimestamp = new Date();

    // 6. Insert data into the primary database (Neon)
    dbClient = await pool.connect();
    let newRecord;
    try {
      const insertQuery = `
        INSERT INTO registrations (registration_id, name, company, phone, address, city, state, day, payment_id, image_url, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *;
      `;
      const values = [
        registrationId, name.trim(), firmName.trim(), phone.trim(), address.trim(),
        district.trim(), state.trim(), attendance, razorpay_payment_id,
        uploadResult.secure_url, registrationTimestamp
      ];
      const result = await dbClient.query(insertQuery, values);
      newRecord = result.rows[0];
    } catch (error) {
      // This specifically catches the unique constraint violation on the 'phone' column
      if (error.code === '23505' && error.constraint === 'registrations_phone_key') {
        return {
          statusCode: 409, // Conflict
          body: JSON.stringify({ error: 'This phone number is already registered.' })
        };
      }
      // For any other database error, re-throw it to be caught by the main catch block
      throw error;
    } finally {
      if (dbClient) {
        dbClient.release(); // IMPORTANT: Release the client back to the pool
      }
    }

    // 7. Sync to Google Sheets (non-blocking "fire-and-forget")
    // This runs in the background and does not delay the response to the user.
    (async () => {
      try {
        const sheets = await getGoogleSheetsClient();
        const newRowData = [
          newRecord.registration_id,
          newRecord.name,
          newRecord.company,
          newRecord.phone,
          newRecord.address,
          newRecord.city,
          newRecord.state,
          newRecord.day,
          newRecord.payment_id,
          new Date(newRecord.timestamp).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          newRecord.image_url,
        ];

        await retryWithBackoff(() =>
          sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A1`, // Appends to the first empty row of the specified sheet
            valueInputOption: "USER_ENTERED",
            resource: { values: [newRowData] },
          })
        );
        console.log(`Successfully synced registration ${newRecord.registration_id} to Google Sheets.`);
      } catch (sheetsError) {
        // Log the error for maintenance but do not fail the user's request
        console.error(`FAILED to sync registration ${newRecord.registration_id} to Google Sheets:`, sheetsError.message);
      }
    })();


    // 8. Prepare and send the success response to the client
    const responseData = {
      status: "success",
      registrationData: {
        registrationId: newRecord.registration_id,
        name: newRecord.name,
        phone: newRecord.phone,
        firmName: newRecord.company,
        attendance: newRecord.day,
        profileImageUrl: newRecord.image_url,
      },
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(responseData),
    };

  } catch (err) {
    // 9. Catch-all error handler for logging and returning a generic error message.
    console.error("SUBMIT_REGISTRATION_ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "An internal server error occurred. Please try again or contact support if the problem persists.",
        details: err.message, // This detail is helpful for debugging in Netlify logs
      }),
    };
  }
};
