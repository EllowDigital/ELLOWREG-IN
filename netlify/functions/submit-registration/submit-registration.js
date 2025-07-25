// This function uses Firebase Firestore and reads credentials from local files
// to avoid environment variable size limits.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { google } = require('googleapis');
const cloudinary = require('cloudinary').v2;

// --- Helper Functions (unchanged) ---
const parseMultipartForm = async (event) => {
  return new Promise((resolve, reject) => {
    const busboy = require('busboy');
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
        files[name] = {
          filename,
          content: Buffer.concat(chunks),
          contentType: mimeType,
        };
      });
      file.on('limit', () => {
        reject(new Error(`File "${filename}" is too large.`));
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', err => reject(new Error(`Error parsing form: ${err}`)));
    bb.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    bb.end();
  });
};

const uploadToCloudinary = (fileBuffer, folderName) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ folder }, (error, result) => {
      if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
      resolve(result);
    }).end(fileBuffer);
  });
};

// --- Firebase Initialization ---
let firebaseApp;
if (!global._firebaseApp) {
  // **MODIFIED**: Read credentials from a local file
  const serviceAccount = require('./firebase-credentials.json');
  global._firebaseApp = initializeApp({
    credential: cert(serviceAccount)
  });
}
firebaseApp = global._firebaseApp;
const db = getFirestore(firebaseApp);

// --- Main Handler ---
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage, paymentScreenshot } = files;

    // Validation... (unchanged)
    if (!name || !phone || !firmName || !profileImage || !paymentScreenshot) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
    }

    const registrationsRef = db.collection('registrations');
    const snapshot = await registrationsRef.where('phone', '==', phone).limit(1).get();

    if (!snapshot.empty) {
      // Handle duplicate... (unchanged)
      return { statusCode: 409, body: JSON.stringify({ error: 'Already registered.' }) };
    }

    const counterRef = db.collection('counters').doc('registrations');
    let nextId;
    await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      nextId = (counterDoc.exists ? counterDoc.data().count : 0) + 1;
      transaction.set(counterRef, { count: nextId }, { merge: true });
    });
    const registrationId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025")
    ]);

    const newRegistrationData = {
      registrationId,
      name,
      phone,
      firmName,
      address,
      district,
      state,
      attendance,
      paymentScreenshotUrl: uploadPaymentResponse.secure_url,
      profileImageUrl: uploadProfileResponse.secure_url,
      createdAt: FieldValue.serverTimestamp()
    };

    await registrationsRef.doc(phone).set(newRegistrationData);

    // **MODIFIED**: Sync to Google Sheets using a local key file
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: './google-credentials.json', // Reads from local file
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Registrations!A1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[ /* Data... (unchanged) */]]
        },
      });
    } catch (sheetError) {
      console.error('GOOGLE_SHEET_SYNC_ERROR:', sheetError.message);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        registrationId, name, phone, firmName,
        profileImageUrl: newRegistrationData.profileImageUrl,
        attendance,
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
