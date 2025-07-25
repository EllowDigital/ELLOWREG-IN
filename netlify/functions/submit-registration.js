const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");

// Google Sheet & Cloudinary config
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const PHONE_COLUMN_INDEX = 4; // E
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

// Retry helper
const retryWithBackoff = async (fn, retries = 3, delay = 500) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i < retries - 1) {
        await new Promise((res) => setTimeout(res, delay * 2 ** i));
      } else throw err;
    }
  }
};

// Parse multipart form
const parseMultipartForm = (event) => new Promise((resolve, reject) => {
  const contentType = event.headers["content-type"] || event.headers["Content-Type"];
  if (!contentType) return reject(new Error("Missing content-type header"));

  const bb = busboy({ headers: { "content-type": contentType }, limits: { fileSize: 5 * 1024 * 1024 } });
  const fields = {}, files = {};

  bb.on("file", (name, file, info) => {
    const chunks = [];
    file.on("data", chunk => chunks.push(chunk));
    file.on("limit", () => reject(new Error(`File "${info.filename}" exceeds 5MB`)));
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
  bb.on("error", err => reject(new Error(`Error parsing form: ${err.message}`)));

  bb.end(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary"));
});

// Upload to Cloudinary
const uploadToCloudinary = (buffer, folder) => new Promise((resolve, reject) => {
  cloudinary.uploader.upload_stream({ folder, resource_type: "auto" }, (err, result) => {
    if (err) reject(new Error(`Cloudinary upload failed: ${err.message}`));
    else resolve(result);
  }).end(buffer);
});

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

    // Verify Razorpay Signature
    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (signature !== razorpay_signature) {
      return {
        statusCode: 400,
        body: JSON.stringify({ status: "error", error: "Invalid Razorpay signature." }),
      };
    }

    // Validate Required Fields
    const required = { name, phone, firmName, address, district, state, attendance };
    for (const [key, val] of Object.entries(required)) {
      if (!val || val.trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ status: "error", error: `Missing: ${key}` }) };
      }
    }
    if (!profileImage) {
      return { statusCode: 400, body: JSON.stringify({ status: "error", error: "Profile photo required." }) };
    }

    // Check duplicates in Google Sheet
    const sheetData = await retryWithBackoff(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:K1000`,
      })
    );

    const rows = sheetData.data.values || [];
    const duplicate = rows.find((row) => row[PHONE_COLUMN_INDEX] === phone);
    if (duplicate) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          registrationData: {
            registrationId: duplicate[1],
            name: duplicate[2],
            firmName: duplicate[3],
            phone: duplicate[4],
            address: duplicate[5],
            district: duplicate[6],
            state: duplicate[7],
            attendance: duplicate[8],
            profileImageUrl: duplicate[10],
          },
        }),
      };
    }

    // Upload Image to Cloudinary
    const uploadResult = await retryWithBackoff(() =>
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025")
    );

    // Generate registration ID
    const newRow = rows.length + 1;
    const registrationId = `TDEXPOUP-${String(newRow).padStart(4, "0")}`;

    // Append row
    await retryWithBackoff(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [[
            new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            registrationId,
            name,
            firmName,
            phone,
            address,
            district,
            state,
            attendance,
            razorpay_payment_id,
            uploadResult.secure_url
          ]]
        }
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId,
          name,
          phone,
          firmName,
          attendance,
          profileImageUrl: uploadResult.secure_url,
        }
      }),
    };

  } catch (err) {
    console.error("REGISTRATION_ERROR:", err.message);
    if (err.code === 'ENOTFOUND' || err.message.includes("network")) {
      return {
        statusCode: 503,
        body: JSON.stringify({
          status: "error",
          error: "Network Error: Please check your internet connection and try again.",
        }),
      };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "Registration failed.",
        details: err.message,
      }),
    };
  }
};
