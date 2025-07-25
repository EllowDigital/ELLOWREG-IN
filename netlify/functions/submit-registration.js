// /netlify/functions/submit-registration.js

const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");

// --- Configuration ---
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const PHONE_COLUMN = "D";
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
const parseMultipartForm = (event) => {
  return new Promise((resolve, reject) => {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType) {
      return reject(new Error('Missing "Content-Type" header.'));
    }
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

    const phoneDataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${PHONE_COLUMN}:${PHONE_COLUMN}`,
    });

    const phoneNumbers = phoneDataResponse.data.values || [];
    const duplicateRowIndex = phoneNumbers.findIndex(row => row && row[0] === phone);

    // --- IMPROVED DUPLICATE HANDLING LOGIC ---
    if (duplicateRowIndex !== -1) {
      const rowNumber = duplicateRowIndex + 1;
      const existingData = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}:K${rowNumber}`,
      });
      const rowDetails = existingData.data.values[0];

      return {
        statusCode: 409, // Conflict
        body: JSON.stringify({
          // A clear status for the frontend to check
          status: "duplicate",
          message: "This mobile number has already been registered.",
          // All data needed to rebuild the entry pass on the frontend
          registrationData: {
            registrationId: rowDetails[1], // Col B
            name: rowDetails[2],           // Col C
            phone: rowDetails[3],          // Col D
            firmName: rowDetails[4],       // Col E
            profileImageUrl: rowDetails[10],// Col K
          },
        }),
      };
    }
    // --- END OF IMPROVEMENT ---

    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025"),
    ]);

    const appendResult = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          "PENDING",
          name, phone, firmName, address, district, state, attendance,
          uploadPaymentResponse.secure_url,
          uploadProfileResponse.secure_url,
        ]],
      },
    });

    const updatedRange = appendResult.data.updates.updatedRange;
    const newRowNumber = parseInt(updatedRange.match(/(\d+)$/)[0], 10);
    const registrationId = `TDEXPOUP-${String(newRowNumber).padStart(4, "0")}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!${REG_ID_COLUMN}${newRowNumber}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[registrationId]] },
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId,
          name,
          phone,
          firmName,
          profileImageUrl: uploadProfileResponse.secure_url,
        }
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