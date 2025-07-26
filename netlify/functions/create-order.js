const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");
const { pool, getGoogleSheetsClient, retryWithBackoff } = require("./utils");

// --- Constants ---
const CLOUDINARY_FOLDER = "expo-profile-images-2025";
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations"; // Ensure this sheet name exists in your Google Sheet

// --- Service Initializations ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// --- Utility Functions ---
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

  let dbClient; // Define client here to be accessible in finally block

  try {
    const { fields, files } = await parseMultipartForm(event);
    const {
      name, phone, firmName, address, district, state, attendance,
      razorpay_order_id, razorpay_payment_id, razorpay_signature
    } = fields;
    const { profileImage } = files;

    // 1. Security Check: Verify Razorpay signature
    const shasum = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest("hex");

    if (digest !== razorpay_signature) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid payment signature." }) };
    }

    // 2. Validate input
    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value || String(value).trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ status: "error", error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) {
      return { statusCode: 400, body: JSON.stringify({ status: "error", error: "A profile photo is required." }) };
    }

    // 3. Upload image to Cloudinary
    const uploadResult = await retryWithBackoff(() =>
      uploadToCloudinary(profileImage.content, CLOUDINARY_FOLDER)
    );

    // 4. Generate a unique Registration ID
    const registrationId = `TDEXPOUP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const registrationTimestamp = new Date();

    // 5. Insert data into the database
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
      if (error.code === '23505' && error.constraint === 'registrations_phone_key') {
        return {
          statusCode: 409, // Conflict
          body: JSON.stringify({ error: 'This phone number is already registered.' })
        };
      }
      throw error; // Re-throw other database errors
    } finally {
      if (dbClient) {
        dbClient.release(); // IMPORTANT: Release the client back to the pool
      }
    }

    // 6. Sync to Google Sheets (non-blocking "fire-and-forget")
    // This ensures the user gets a fast response even if Sheets API is slow.
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
            range: `${SHEET_NAME}!A1`,
            valueInputOption: "USER_ENTERED",
            resource: { values: [newRowData] },
          })
        );
        console.log(`Successfully synced registration ${newRecord.registration_id} to Google Sheets.`);
      } catch (sheetsError) {
        console.error(`FAILED to sync registration ${newRecord.registration_id} to Google Sheets:`, sheetsError.message);
      }
    })();


    // 7. Success response
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
    console.error("SUBMIT_REGISTRATION_ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "An internal server error occurred. Please try again or contact support if the problem persists.",
        details: err.message,
      }),
    };
  }
};
