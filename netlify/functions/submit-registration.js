// This function requires 'busboy' to parse multipart/form-data with file uploads.
// Netlify's environment includes 'busboy'.
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// --- Helper function to parse multipart form data ---
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
    const fields = {};
    const files = {};
    const bb = busboy({
      headers: event.headers,
      limits: { fileSize: 4 * 1024 * 1024 } // 4MB file size limit
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
      // Handle file size limit exceeded
      file.on('limit', () => {
        reject(new Error('File size limit exceeded. Please upload an image smaller than 4MB.'));
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err.message}`)));
    bb.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    bb.end();
  });
};

// --- Main Handler Function ---
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // 1. Parse and Validate Form Data
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const paymentScreenshot = files.paymentScreenshot;

    const requiredFields = { name, phone, firmName, address, district, state, attendance };
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!value) {
        return { statusCode: 400, body: JSON.stringify({ error: `Missing required field: ${key}. Please fill out the entire form.` }) };
      }
    }
    if (!paymentScreenshot) {
      return { statusCode: 400, body: JSON.stringify({ error: "Payment screenshot is missing. Please upload the file." }) };
    }

    // --- Configure Services ---
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

    // 2. Check for Duplicate Phone Number
    try {
      const getRows = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        // Fetch Enrollment ID (Col B), Name (Col C), and Phone (Col D)
        range: 'Registrations!B:D',
      });

      if (getRows.data.values) {
        for (const row of getRows.data.values) {
          const [enrollmentId, registeredName, existingPhone] = row;
          if (existingPhone === phone) {
            // Found a duplicate, return details
            return {
              statusCode: 409, // Conflict
              body: JSON.stringify({
                error: 'This mobile number is already registered.',
                details: {
                  name: registeredName,
                  enrollmentId: enrollmentId,
                }
              }),
            };
          }
        }
      }
    } catch (err) {
      console.error("Google Sheets read error:", err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not verify your phone number. Please try again later.' }) };
    }

    // 3. Upload Screenshot to Cloudinary
    let uploadResponse;
    try {
      uploadResponse = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: "expo-registrations-2025" },
          (error, result) => error ? reject(error) : resolve(result)
        );
        uploadStream.end(paymentScreenshot.content);
      });
    } catch (err) {
      console.error("Cloudinary upload error:", err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to upload screenshot. Please try again.' }) };
    }

    // 4. Generate Unique Enrollment ID
    const timestamp = Date.now().toString().slice(-5);
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const enrollmentId = `TDE25-${randomSuffix}${timestamp}`;

    // 5. Append Data to Google Sheet
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Registrations',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            enrollmentId, name, phone, firmName, address, district, state, attendance,
            uploadResponse.secure_url,
          ]],
        },
      });
    } catch (err) {
      console.error("Google Sheets write error:", err);
      // Attempt to delete the already-uploaded image if the sheet write fails, to prevent orphaned files.
      if (uploadResponse.public_id) {
        await cloudinary.uploader.destroy(uploadResponse.public_id);
      }
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not save your registration details. Please contact support.' }) };
    }

    // 6. Return Success
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentId: enrollmentId }),
    };

  } catch (error) {
    console.error('Unhandled Registration Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'An unexpected error occurred. Please try again.' }),
    };
  }
};
