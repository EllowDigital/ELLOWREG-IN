const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");

// Configuration
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Registrations";
const PHONE_COLUMN_INDEX = 4;
const REG_ID_COLUMN_LETTER = "B";

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

const retryWithBackoff = async (operation, retries = 3, initialDelay = 500) => {
  let delay = initialDelay;
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (err) {
      if (i < retries - 1) {
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
};

const parseMultipartForm = (event) => new Promise((resolve, reject) => {
  const contentType = event.headers["content-type"] || event.headers["Content-Type"];
  if (!contentType) return reject(new Error('Missing "Content-Type" header.'));
  const bb = busboy({
    headers: { "content-type": contentType },
    limits: { fileSize: 5 * 1024 * 1024 },
  });
  const fields = {};
  const files = {};
  bb.on("file", (name, file, info) => {
    const chunks = [];
    file.on("data", chunk => chunks.push(chunk));
    file.on("limit", () => reject(new Error(`File "${info.filename}" exceeds 5MB.`)));
    file.on("end", () => {
      files[name] = { filename: info.filename, content: Buffer.concat(chunks), contentType: info.mimeType };
    });
  });
  bb.on("field", (name, val) => { fields[name] = val; });
  bb.on("close", () => resolve({ fields, files }));
  bb.on("error", err => reject(new Error(`Form parse error: ${err}`)));
  bb.end(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary"));
});

const uploadToCloudinary = (buffer, folder) => new Promise((resolve, reject) => {
  cloudinary.uploader.upload_stream({ folder, resource_type: "auto" }, (err, result) => {
    if (err) return reject(new Error(`Cloudinary upload failed: ${err.message}`));
    resolve(result);
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

    // Step 1: Verify Razorpay Payment
    const signatureBase = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(signatureBase)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return {
        statusCode: 400,
        body: JSON.stringify({ status: "error", error: "Invalid Razorpay signature. Payment not verified." }),
      };
    }

    // Step 2: Validate Required Fields
    const required = { name, phone, firmName, address, district, state, attendance };
    for (const [key, val] of Object.entries(required)) {
      if (!val || val.trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ status: "error", error: `Missing: ${key}` }) };
      }
    }
    if (!profileImage) {
      return { statusCode: 400, body: JSON.stringify({ status: "error", error: "Profile photo required." }) };
    }

    // Step 3: Check if phone already registered
    const sheetData = await retryWithBackoff(() =>
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:K1000` })
    );
    const rows = sheetData.data.values || [];
    const existing = rows.find(row => row[PHONE_COLUMN_INDEX] === phone);
    if (existing) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          registrationData: {
            registrationId: existing[1],
            name: existing[2],
            firmName: existing[3],
            phone: existing[4],
            address: existing[5],
            district: existing[6],
            state: existing[7],
            attendance: existing[8],
            profileImageUrl: existing[10],
          },
        }),
      };
    }

    // Step 4: Upload Image to Cloudinary
    const uploadRes = await retryWithBackoff(() =>
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025")
    );

    // Step 5: Get safe row count BEFORE appending
    const totalRows = rows.length + 1;
    const registrationId = `TDEXPOUP-${String(totalRows).padStart(4, "0")}`;

    // Step 6: Append New Row to Sheet
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
            uploadRes.secure_url
          ]]
        }
      })
    );

    // Step 7: Return Success Response
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
          attendance,
          profileImageUrl: uploadRes.secure_url,
        }
      }),
    };

  } catch (err) {
    console.error("REGISTRATION_ERROR", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "Registration failed. Please try again.",
        details: err.message,
      }),
    };
  }
};
