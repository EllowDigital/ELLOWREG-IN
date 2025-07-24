// This function requires 'busboy' to parse multipart/form-data with file uploads.
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// Helper function to parse multipart form data
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
    const fields = {};
    const files = {};
    const bb = busboy({
      headers: event.headers,
      limits: { fileSize: 5 * 1024 * 1024 } // 5MB file size limit
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
      file.on('error', err => {
        reject(new Error(`File upload error: ${err}`));
      });
    });

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err}`)));
    bb.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    bb.end();
  });
};

// Helper to upload a file to Cloudinary
const uploadToCloudinary = (file, folder) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream({ folder },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    uploadStream.end(file.content);
  });
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // --- Configure Cloudinary ---
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
      if (!value) {
        return { statusCode: 400, body: JSON.stringify({ error: `Missing required field: ${key}` }) };
      }
    }
    if (!profileImage) return { statusCode: 400, body: JSON.stringify({ error: 'Profile photo is required.' }) };
    if (!paymentScreenshot) return { statusCode: 400, body: JSON.stringify({ error: 'Payment screenshot is required.' }) };

    // --- Authenticate with Google ---
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 2. Check for Duplicate Phone Number and Get Row Count
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Registrations!B:D', // Get Enrollment ID, Name, Phone
    });

    const rows = sheetData.data.values || [];
    const rowCount = rows.length; // Includes header row

    for (const row of rows) {
      const existingPhone = row[2]; // Phone number is in the 3rd column of the B:D range
      if (existingPhone === phone) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This mobile number has already been registered.',
            details: { enrollmentId: row[0], name: row[1] }
          }),
        };
      }
    }

    // 3. Generate Sequential Enrollment Number
    const nextId = rowCount; // First registration will be 1 (since header is row 0)
    const enrollmentId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    // 4. Upload Images to Cloudinary
    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot, "expo-payments-2025")
    ]);

    // 5. Append Data to Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Registrations',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          enrollmentId,
          name,
          phone,
          firmName,
          address,
          district,
          state,
          attendance,
          uploadPaymentResponse.secure_url,
          uploadProfileResponse.secure_url, // New profile photo URL
        ]],
      },
    });

    // 6. Return Success with all data needed for the ID card
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enrollmentId,
        name,
        phone,
        profileImageUrl: uploadProfileResponse.secure_url,
      }),
    };

  } catch (error) {
    console.error('REGISTRATION_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An unexpected error occurred: ${error.message}` }),
    };
  }
};
