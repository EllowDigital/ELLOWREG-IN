// submit-registration.js

const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;
const busboy = require('busboy');

// Helper function to parse multipart form data with a file size limit
const parseMultipartForm = (event) => {
  return new Promise((resolve, reject) => {
    // Find the 'content-type' header, ignoring case.
    const contentType = event.headers['content-type'] || event.headers['Content-Type'];
    if (!contentType) {
      return reject(new Error('Missing "Content-Type" header.'));
    }

    const bb = busboy({
      // Provide the content-type header in the format busboy expects.
      headers: { 'content-type': contentType },
      limits: { fileSize: 5 * 1024 * 1024 } // 5MB file size limit per file
    });

    const fields = {};
    const files = {};

    bb.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        files[name] = {
          filename,
          content: Buffer.concat(chunks),
          contentType: mimeType,
        };
      });
      file.on('limit', () => {
        reject(new Error(`File "${filename}" is too large. The limit is 5MB.`));
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err}`)));

    // Write the body buffer to busboy for parsing.
    bb.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary'));
  });
};

// Helper function to upload a file buffer to Cloudinary
const uploadToCloudinary = (fileBuffer, folderName) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: folderName },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // --- Configure Services ---
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    // 1. Parse and Validate Form Data
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage, paymentScreenshot } = files;

    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value || value.trim() === '') {
        return { statusCode: 400, body: JSON.stringify({ error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) return { statusCode: 400, body: JSON.stringify({ error: 'Profile photo is required.' }) };
    if (!paymentScreenshot) return { statusCode: 400, body: JSON.stringify({ error: 'Payment screenshot is required.' }) };

    // --- Authenticate with Google Sheets API ---
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 2. Check for Duplicate Phone Number and Get Row Count
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Registrations!B:K',
    });

    const rows = sheetData.data.values || [];
    const nextId = rows.length + 1;

    for (const row of rows) {
      const existingPhone = row[2]; // Column D

      if (existingPhone === phone) {
        const existingRegistrationId = row[0]; // Column B
        const existingName = row[1];       // Column C
        const existingFirmName = row[3];     // Column E
        const existingProfileImageUrl = row[9]; // Column K

        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This mobile number has already been registered.',
            details: {
              registrationId: existingRegistrationId,
              name: existingName,
              firmName: existingFirmName,
              phone: existingPhone,
              profileImageUrl: existingProfileImageUrl
            }
          }),
        };
      }
    }

    // 3. Generate the new, sequential Registration Number
    const registrationId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    // 4. Upload both images to Cloudinary in parallel
    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025")
    ]);

    // 5. Append all data to the Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Registrations',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), // A
          registrationId, // B
          name,           // C
          phone,          // D
          firmName,       // E
          address,        // F
          district,       // G
          state,          // H
          attendance,     // I
          uploadPaymentResponse.secure_url, // J
          uploadProfileResponse.secure_url,   // K
        ]],
      },
    });

    // 6. Return a successful response
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
    console.error('REGISTRATION_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An unexpected error occurred. Details: ${error.message}` }),
    };
  }
};