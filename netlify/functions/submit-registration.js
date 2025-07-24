// This function requires 'busboy' to parse multipart/form-data with file uploads.
// Netlify's environment includes 'busboy'.
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// --- Helper function to parse multipart form data ---
// This is necessary to handle file uploads in a Netlify function.
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
    const fields = {};
    const files = {};
    const bb = busboy({ headers: event.headers });

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

exports.handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // --- Configure services using your Netlify environment variables ---
    cloudinary.config({ 
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
      api_key: process.env.CLOUDINARY_API_KEY, 
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    
    // 1. Parse the incoming form data to separate fields and the file
    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const paymentScreenshot = files.paymentScreenshot;

    if (!paymentScreenshot) {
      throw new Error("Payment screenshot file is missing.");
    }

    // 2. Generate a unique, user-friendly Enrollment ID
    const timestamp = Date.now().toString().slice(-5); // Last 5 digits of timestamp
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 random chars
    const enrollmentId = `TDE25-${randomSuffix}${timestamp}`;
    
    // 3. Upload the payment screenshot file to Cloudinary
    const uploadResponse = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "expo-registrations-2025" }, // Organizes uploads in Cloudinary
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        uploadStream.end(paymentScreenshot.content);
    });

    // 4. Authenticate and write data to your Google Sheet
    const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Registrations!A1', // Appends to the first empty row of the "Registrations" sheet
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
                uploadResponse.secure_url, // The direct link to the uploaded image
            ]],
        },
    });

    // 5. Send the successful response back to the user's browser
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentId: enrollmentId }),
    };

  } catch (error) {
    console.error('REGISTRATION_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Failed to process registration. Please check server logs. ${error.message}` }),
    };
  }
};
