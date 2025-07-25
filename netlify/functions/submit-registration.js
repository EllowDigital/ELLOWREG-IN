const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const busboy = require("busboy");
const crypto = require("crypto");

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

const retryWithBackoff = async (operation, retries = 3, initialDelay = 500) => {
  let delay = initialDelay;
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i < retries - 1) {
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
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
      file.on("data", chunk => chunks.push(chunk));
      file.on("limit", () => reject(new Error(`File "${filename}" exceeds 5MB.`)));
      file.on("end", () => {
        files[name] = { filename, content: Buffer.concat(chunks), contentType: mimeType };
      });
    });
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("close", () => resolve({ fields, files }));
    bb.on("error", err => reject(new Error(`Error parsing form: ${err}`)));
    bb.end(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary"));
  });
};

const uploadToCloudinary = (fileBuffer, folderName) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: folderName, resource_type: "auto" },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        resolve(result);
      }
    ).end(fileBuffer);
  });
};

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

    // 1. Verify Razorpay Signature
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return {
        statusCode: 400,
        body: JSON.stringify({ status: "error", error: "Invalid Razorpay signature. Payment not verified." }),
      };
    }

    // 2. Validate Form
    const required = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(required)) {
      if (!value || String(value).trim() === "") {
        return { statusCode: 400, body: JSON.stringify({ status: "error", error: `Missing: ${key}` }) };
      }
    }
    if (!profileImage) return { statusCode: 400, body: JSON.stringify({ status: "error", error: "Profile photo required." }) };

    // 3. Check for Duplicate Phone
    const response = await retryWithBackoff(() => sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:K1000`, // full data
    }));
    const rows = response.data.values || [];

    const existingRow = rows.find(row => row[4] === phone); // phone is column E
    if (existingRow) {
      const registrationId = existingRow[1]; // column B
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          registrationData: {
            registrationId,
            name: existingRow[2],
            firmName: existingRow[3],
            phone: existingRow[4],
            address: existingRow[5],
            district: existingRow[6],
            state: existingRow[7],
            attendance: existingRow[8],
            profileImageUrl: existingRow[10], // image url
          }
        })
      };
    }

    // 4. Upload Image
    const uploadRes = await retryWithBackoff(() =>
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025")
    );

    // 5. Append to Google Sheet
    const append = await retryWithBackoff(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_NAME,
        valueInputOption: "USER_ENTERED",
        resource: {
          values: [[
            new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), "PENDING",
            name, firmName, phone, address, district, state, attendance,
            razorpay_payment_id, uploadRes.secure_url
          ]]
        },
      })
    );

    // 6. Generate Registration ID
    const newRow = parseInt(append.data.updates.updatedRange.match(/(\d+)$/)[0], 10);
    const registrationId = `TDEXPOUP-${String(newRow).padStart(4, "0")}`;

    await retryWithBackoff(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!${REG_ID_COLUMN}${newRow}`,
        valueInputOption: "USER_ENTERED",
        resource: { values: [[registrationId]] },
      })
    );

    // 7. Return Entry Pass Data
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "success",
        registrationData: {
          registrationId, name, phone, firmName, attendance,
          profileImageUrl: uploadRes.secure_url,
        }
      }),
    };

  } catch (error) {
    console.error("REGISTRATION_ERROR:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: "error",
        error: "Registration failed.",
        details: error.message,
      }),
    };
  }
};
