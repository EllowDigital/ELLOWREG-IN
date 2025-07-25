// WARNING: This version uses Google Sheets as a database.
// It is NOT recommended for production use as it is not scalable and can fail under load.

const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;
const busboy = require('busboy');

// Helper function to parse multipart form data
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const bb = busboy({
      headers: event.headers,
      limits: { fileSize: 5 * 1024 * 1024 } // 5MB
    });

    bb.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        files[name] = { filename, content: Buffer.concat(chunks), contentType: mimeType };
      });
      file.on('limit', () => reject(new Error(`File "${filename}" is too large.`)));
    });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err}`)));
    bb.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    bb.end();
  });
};

// Helper function to upload to Cloudinary
const uploadToCloudinary = (fileBuffer, folderName) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ folder: folderName }, (error, result) => {
      if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
      resolve(result);
    }).end(fileBuffer);
  });
};

// Main handler function
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // Configure services from environment variables
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

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

    // 2. Check for Duplicate Phone Number
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Registrations!A:K', // Fetch all relevant columns
    });

    const rows = sheetData.data.values || [];
    const nextId = rows.length; // Use length before adding header row consideration

    // Check for duplicate phone, assuming phone is in Column D
    const duplicateRow = rows.find(row => row[3] === phone);
    if (duplicateRow) {
      // Return details of the existing registration
      return {
        statusCode: 409,
        body: JSON.stringify({
          error: 'This mobile number has already been registered.',
          details: {
            registrationId: duplicateRow[1],
            name: duplicateRow[2],
            firmName: duplicateRow[4],
            phone: duplicateRow[3],
            profileImageUrl: duplicateRow[10], // Assuming profile image URL is in Column K
            attendance: duplicateRow[8] // Assuming attendance is in Column I
          }
        }),
      };
    }

    // 3. Generate the new, sequential Registration Number
    const registrationId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    // 4. Upload images to Cloudinary
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

    // 6. Return a successful response with all data needed for the pass
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationId,
        name,
        phone,
        firmName,
        profileImageUrl: uploadProfileResponse.secure_url,
        attendance: attendance, // *** UPDATED: Added attendance to the response ***
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
