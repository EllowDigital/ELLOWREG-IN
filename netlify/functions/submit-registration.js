// This function requires 'busboy' to parse multipart/form-data with file uploads.
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// Helper function to parse multipart form data with a file size limit
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
    const fields = {};
    const files = {};
    const bb = busboy({
      headers: event.headers,
      limits: { fileSize: 5 * 1024 * 1024 } // 5MB file size limit per file
    });

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
    bb.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    bb.end();
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
    const nextId = rows.length + 1; // Start from 1, not 0

    for (const row of rows) {
      // Index mapping based on the range B:K -> B=0, C=1, D=2, E=3, ..., K=9
      const existingPhone = row[2];

      if (existingPhone === phone) {
        const existingEnrollmentId = row[0];
        const existingName = row[1];
        const existingFirmName = row[3];
        const existingProfileImageUrl = row[9];

        // If a duplicate is found, return a 409 Conflict status with all details.
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This mobile number has already been registered.',
            details: {
              enrollmentId: existingEnrollmentId,
              name: existingName,
              firmName: existingFirmName,
              profileImageUrl: existingProfileImageUrl
            }
          }),
        };
      }
    }

    // 3. Generate the new, sequential Enrollment Number
    const enrollmentId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

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
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          enrollmentId, name, phone, firmName,
          address, district, state, attendance,
          uploadPaymentResponse.secure_url,
          uploadProfileResponse.secure_url,
        ]],
      },
    });

    // 6. Return a successful response for the new ID card
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enrollmentId, name, phone, firmName,
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
