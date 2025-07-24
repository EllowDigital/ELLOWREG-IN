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
      // This event is triggered for each file in the form.
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

      // Handle file size limit error
      file.on('limit', () => {
        reject(new Error(`File "${filename}" is too large. The limit is 5MB.`));
      });
    });

    bb.on('field', (name, val) => {
      // This event is triggered for each text field.
      fields[name] = val;
    });

    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err}`)));

    // Write the request body to busboy for parsing.
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
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // --- Configure Cloudinary using secure environment variables ---
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    // 1. Parse and Validate Form Data
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage, paymentScreenshot } = files;

    // Server-side validation for all required fields and files
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

    // 2. Check for Duplicate Phone Number and Get Last Row Count
    // Fetches columns B (Enrollment ID), C (Name), and D (Phone) for efficiency
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Registrations!B:D',
    });

    const rows = sheetData.data.values || [];
    // The first row is headers, so the next ID is the current number of data rows + 1.
    const nextId = rows.length;

    for (const row of rows) {
      const existingEnrollmentId = row[0];
      const existingName = row[1];
      const existingPhone = row[2];

      if (existingPhone === phone) {
        // If a duplicate is found, return a 409 Conflict status with existing user details.
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'This mobile number has already been registered.',
            details: { enrollmentId: existingEnrollmentId, name: existingName }
          }),
        };
      }
    }

    // 3. Generate the new, sequential Enrollment Number
    const enrollmentId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    // 4. Upload both images to Cloudinary in parallel for better performance
    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025")
    ]);

    // 5. Append all data to the Google Sheet in the correct order
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Registrations', // Append to the first empty row of the sheet
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          enrollmentId, name, phone, firmName,
          address, district, state, attendance,
          uploadPaymentResponse.secure_url, // Payment screenshot URL
          uploadProfileResponse.secure_url,   // Profile photo URL
        ]],
      },
    });

    // 6. Return a successful response with all data needed for the ID card
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enrollmentId,
        name,
        phone,
        firmName,
        profileImageUrl: uploadProfileResponse.secure_url,
      }),
    };

  } catch (error) {
    // Log the detailed error on the server for debugging
    console.error('REGISTRATION_ERROR:', error);
    // Return a generic but informative error message to the user
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An unexpected error occurred. Please try again or contact support. Details: ${error.message}` }),
    };
  }
};
