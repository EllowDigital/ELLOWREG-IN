// /netlify/functions/submit-registration.js

const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");
const { pool } = require("./utils");

// --- Constants ---
const CLOUDINARY_FOLDER = "expo-profile-images-2025";

// --- Cloudinary Configuration ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/**
 * Parses a multipart/form-data request and validates the file type on the server.
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
    // --- SERVER-SIDE FILE VALIDATION ---
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (!allowedTypes.includes(info.mimeType)) {
      // If the file type is not allowed, stop processing and reject the promise.
      return reject(new Error(`Invalid file type. Only JPG and PNG are allowed.`));
    }
    // --- END VALIDATION ---

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
      // If user exists, mark them for a re-sync for the "Delta Sync" system.
      await dbClient.query('UPDATE registrations SET needs_sync = true WHERE phone = $1', [trimmedPhone]);

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
    const uploadResult = await uploadToCloudinary(profileImage.content, CLOUDINARY_FOLDER);
    const registrationId = `TDEXPOUP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const registrationTimestamp = new Date();

    const insertQuery = `INSERT INTO registrations (registration_id, name, company, phone, address, city, state, day, payment_id, image_url, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;`;
    const values = [registrationId, name.trim(), firmName.trim(), trimmedPhone, address.trim(), district.trim(), state.trim(), attendance, null, uploadResult.secure_url, registrationTimestamp];
    const result = await dbClient.query(insertQuery, values);
    const newRecord = result.rows[0];

    // --- Step 4: Return Success to the User ---
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
    if (dbClient) {
      dbClient.release();
    }
  }
};
