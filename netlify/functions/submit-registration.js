// /netlify/functions/submit-registration.js

const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto"); // Required for payment verification

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const PHONE_COLUMN = "E";
const REG_ID_COLUMN = "B";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// --- Helper Functions ---
const retryWithBackoff = async (operation, retries = 3, initialDelay = 500) => {
  let delay = initialDelay;
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i < retries - 1) {
        console.log(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        console.error(`All ${retries} attempts failed.`);
        throw error;
      }
    }
  }
};

const parseMultipartForm = (event) => {
  return new Promise((resolve, reject) => {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType) return reject(new Error('Missing "Content-Type" header.'));
    const bb = busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: 5 * 1024 * 1024 },
    });
    const fields = {};
    const files = {};
    bb.on("file", (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("limit", () => reject(new Error(`File "${filename}" exceeds 5MB limit.`)));
      file.on("end", () => {
        files[name] = { filename, content: Buffer.concat(chunks), contentType: mimeType };
      });
    });
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("close", () => resolve({ fields, files }));
    bb.on("error", (err) => reject(new Error(`Error parsing form: ${err}`)));
    bb.end(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary"));
  });
};

const uploadToCloudinary = (fileBuffer, folderName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: folderName, resource_type: "auto" },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

// --- Main Handler Logic ---
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const { fields, files } = await parseMultipartForm(event);
    const {
      name, phone, firmName, address, district, state, attendance,
      razorpay_order_id, razorpay_payment_id, razorpay_signature
    } = fields;
    const { profileImage } = files;

    // --- 1. PAYMENT VERIFICATION (CRITICAL STEP) ---
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return {
        statusCode: 400,
        body: JSON.stringify({ status: "error", error: "Invalid payment signature. Registration failed." }),
      };
    }

    // --- 2. VALIDATE FORM FIELDS ---
    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value || String(value).trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ status: "error", error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) return { statusCode: 400, body: JSON.stringify({ status: "error", error: "Profile photo is required." }) };

    // --- 3. CHECK FOR DUPLICATE PHONE NUMBER ---
    const phoneDataResponse = await retryWithBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${PHONE_COLUMN}:${PHONE_COLUMN}`,
    }));
    const phoneNumbers = phoneDataResponse.data.values || [];
    const duplicateRowIndex = phoneNumbers.findIndex(row => row && row[0] === phone);

    if (duplicateRowIndex !== -1) {
      // Logic for handling duplicates remains the same
      // ...
    }

    // --- 4. UPLOAD PROFILE IMAGE ---
    const uploadProfileResponse = await retryWithBackoff(() => uploadToCloudinary(profileImage.content, "expo-profile-images-2025"));

    // --- 5. APPEND TO GOOGLE SHEET ---
    const appendResult = await retryWithBackoff(() => sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), "PENDING",
          name, firmName, phone, address, district, state, attendance,
          razorpay_payment_id, // Store Payment ID instead of screenshot URL
          uploadProfileResponse.secure_url,
        ]],
      },
    }));

    // --- 6. GENERATE AND UPDATE REGISTRATION ID ---
    const updatedRange = appendResult.data.updates.updatedRange;
    const newRowNumber = parseInt(updatedRange.match(/(\d+)$/)[0], 10);
    const registrationId = `TDEXPOUP-${String(newRowNumber).padStart(4, "0")}`;

    await retryWithBackoff(() => sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${REG_ID_COLUMN}${newRowNumber}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[registrationId]] },
    }));

    // --- 7. RETURN SUCCESS RESPONSE ---
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId, name, phone, firmName, attendance,
          profileImageUrl: uploadProfileResponse.secure_url,
        }
      }),
    };

  } catch (error) {
    console.error("REGISTRATION_ERROR:", error);
    return {
      statusCode: error.code || 500,
      body: JSON.stringify({
        status: "error",
        error: "Registration failed after multiple attempts. Please try again later.",
        details: error.message,
      }),
    };
  }
};
