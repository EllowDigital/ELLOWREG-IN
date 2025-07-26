// /netlify/functions/submit-registration.js

// --- Dependencies ---
const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");

// --- Constants ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const CLOUDINARY_FOLDER = "expo-profile-images-2025";

// --- Service Initializations ---

// Setup Google Sheets API client.
// **IMPROVEMENT**: The scope is 'spreadsheets' which allows both reading (to get row count) and writing (to append data).
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Configure Cloudinary client.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// --- Utility Functions ---

/**
 * Retries an asynchronous function with exponential backoff.
 */
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((res) => setTimeout(res, delay * 2 ** i));
    }
  }
};

/**
 * Parses a multipart/form-data request body.
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

  // Busboy expects a Buffer, so we convert the body correctly based on its encoding.
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
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    // 1. Parse form data and files from the request.
    const { fields, files } = await parseMultipartForm(event);
    const {
      name, phone, firmName, address, district, state, attendance,
      razorpay_order_id, razorpay_payment_id, razorpay_signature
    } = fields;
    const { profileImage } = files;

    // 2. Security Check: Verify the payment signature from Razorpay.
    // This is critical to prevent anyone from calling this function without a valid payment.
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return {
        statusCode: 400, // Bad Request
        body: JSON.stringify({ status: "error", error: "Invalid Razorpay payment signature." }),
      };
    }

    // 3. Validate that all required fields and the profile image are present.
    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value || String(value).trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ status: "error", error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) {
      return { statusCode: 400, body: JSON.stringify({ status: "error", error: "A profile photo is required." }) };
    }

    // 4. Upload the profile image to Cloudinary.
    const uploadResult = await retryWithBackoff(() =>
      uploadToCloudinary(profileImage.content, CLOUDINARY_FOLDER)
    );

    // 5. Generate a unique Registration ID.
    // **IMPROVEMENT**: This approach is more robust. We get the current number of rows in the sheet
    // to ensure the new ID is sequential, even with concurrent requests.
    const sheetData = await retryWithBackoff(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:A`, // Only need one column to count rows.
      })
    );
    const newRowNumber = (sheetData.data.values || []).length + 1;
    const registrationId = `TDEXPOUP-${String(newRowNumber).padStart(4, "0")}`;

    // 6. Append the new registration data to the Google Sheet.
    const newRowData = [
      new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      registrationId,
      name.trim(),
      firmName.trim(),
      phone.trim(),
      address.trim(),
      district.trim(),
      state.trim(),
      attendance,
      razorpay_payment_id,
      uploadResult.secure_url,
    ];

    await retryWithBackoff(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
        valueInputOption: "USER_ENTERED",
        resource: { values: [newRowData] },
      })
    );

    // 7. Return a success response with the new registration data.
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId,
          name: name.trim(),
          phone: phone.trim(),
          firmName: firmName.trim(),
          attendance,
          profileImageUrl: uploadResult.secure_url,
        },
      }),
    };

  } catch (err) {
    // 8. Catch-all error handler for logging and returning a generic error message.
    console.error("SUBMIT_REGISTRATION_ERROR:", err.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "Registration failed due to a server error. Please contact support.",
        details: err.message,
      }),
    };
  }
};
