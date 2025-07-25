// /netlify/functions/submit-registration.js

const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");

// --- Configuration ---
// Placed outside the handler to be reused in "warm" function invocations
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations"; // Use a constant for the sheet name
const PHONE_COLUMN = "D"; // Column D for phone numbers
const REG_ID_COLUMN = "B"; // Column B for Registration ID

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

// --- Helper Functions (No changes needed, they are well-written) ---

const parseMultipartForm = (event) => {
  return new Promise((resolve, reject) => {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType) {
      return reject(new Error('Missing "Content-Type" header.'));
    }
    const bb = busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
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
    // 1. PARSE AND VALIDATE FORM DATA
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage, paymentScreenshot } = files;

    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value || String(value).trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) return { statusCode: 400, body: JSON.stringify({ error: "Profile photo is required." }) };
    if (!paymentScreenshot) return { statusCode: 400, body: JSON.stringify({ error: "Payment screenshot is required." }) };

    // 2. CHECK FOR DUPLICATE PHONE NUMBER (Optimized)
    // Fetches only the phone number column for better performance.
    const phoneDataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${PHONE_COLUMN}:${PHONE_COLUMN}`,
    });

    const phoneNumbers = phoneDataResponse.data.values || [];
    const duplicateRowIndex = phoneNumbers.findIndex(row => row[0] === phone);

    if (duplicateRowIndex !== -1) {
      const rowNumber = duplicateRowIndex + 1; // +1 because sheet rows are 1-based
      const existingData = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}:K${rowNumber}`,
      });
      const rowDetails = existingData.data.values[0];

      return {
        statusCode: 409, // Conflict
        body: JSON.stringify({
          error: "This mobile number has already been registered.",
          details: {
            registrationId: rowDetails[1], // Col B
            name: rowDetails[2],           // Col C
            firmName: rowDetails[4],       // Col E
            phone: rowDetails[3],          // Col D
            profileImageUrl: rowDetails[10], // Col K
          },
        }),
      };
    }

    // 3. UPLOAD IMAGES TO CLOUDINARY
    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025"),
    ]);

    // 4. ATOMIC APPEND & UPDATE - THE CORE FIX FOR RACE CONDITIONS
    // Step 4a: Append the new row with a placeholder for the registration ID.
    const appendResult = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), // A: Timestamp
          "PENDING", // B: Registration ID (Placeholder)
          name, firmName, phone, address, district, state, attendance, // C-I
          uploadPaymentResponse.secure_url, // J: Payment URL
          uploadProfileResponse.secure_url,  // K: Profile URL
        ]],
      },
    });

    // Step 4b: Extract the row number from the API response to generate a unique ID.
    const updatedRange = appendResult.data.updates.updatedRange;
    // Regex to safely extract the row number (e.g., from 'Registrations'!A102:K102)
    const newRowNumber = parseInt(updatedRange.match(/(\d+)$/)[0], 10);
    const registrationId = `TDEXPOUP-${String(newRowNumber).padStart(4, "0")}`;

    // Step 4c: Update the newly created row with the final, unique registration ID.
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${REG_ID_COLUMN}${newRowNumber}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[registrationId]] },
    });

    // 5. RETURN SUCCESSFUL RESPONSE
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationId,
        name,
        phone,
        firmName,
        profileImageUrl: uploadProfileResponse.secure_url,
      }),
    };

  } catch (error) {
    console.error("REGISTRATION_ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "An unexpected error occurred during registration.",
        details: error.message,
      }),
    };
  }
};