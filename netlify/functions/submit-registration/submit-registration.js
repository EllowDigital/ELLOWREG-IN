// This function reads credentials from Base64 encoded environment variables.
// This is the most secure and reliable method.
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


// --- Firebase & Google Initialization from Base64 ---
let firebaseApp;
let googleAuth;

// This block ensures initialization only happens once
if (!global._firebaseApp) {
  // Decode Firebase credentials from Base64
  const firebaseCredsB64 = process.env.FIREBASE_CREDENTIALS_B64;
  if (!firebaseCredsB64) {
    throw new Error("Firebase credentials (Base64) are not set in environment variables.");
  }
  const decodedFirebaseCreds = Buffer.from(firebaseCredsB64, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(decodedFirebaseCreds);

  global._firebaseApp = initializeApp({
    credential: cert(serviceAccount)
  });

  // Decode Google credentials from Base64
  const googleCredsB64 = process.env.GOOGLE_CREDENTIALS_B64;
  if (!googleCredsB64) {
    throw new Error("Google Sheets credentials (Base64) are not set in environment variables.");
  }
  const decodedGoogleCreds = Buffer.from(googleCredsB64, 'base64').toString('utf-8');
  const googleKey = JSON.parse(decodedGoogleCreds);

  global._googleAuth = new google.auth.GoogleAuth({
    credentials: googleKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

firebaseApp = global._firebaseApp;
googleAuth = global._googleAuth;
const db = getFirestore(firebaseApp);


// --- Main Handler ---
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // Configure Cloudinary (uses standard env vars)
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    const { fields, files } = await parseMultipartForm(event);
    const { name, phone, firmName, address, district, state, attendance } = fields;
    const { profileImage, paymentScreenshot } = files;

    // --- Validation (unchanged) ---
    if (!name || !phone || !firmName || !profileImage || !paymentScreenshot) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
    }

    // --- Firestore Operations (unchanged) ---
    const registrationsRef = db.collection('registrations');
    const snapshot = await registrationsRef.where('phone', '==', phone).limit(1).get();

    if (!snapshot.empty) {
      const existingDoc = snapshot.docs[0].data();
      return { statusCode: 409, body: JSON.stringify({ error: 'This mobile number has already been registered.', details: existingDoc }) };
    }

    const counterRef = db.collection('counters').doc('registrations');
    const { nextId } = await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      const newCount = (counterDoc.exists ? counterDoc.data().count : 0) + 1;
      transaction.set(counterRef, { count: newCount }, { merge: true });
      return { nextId: newCount };
    });
    const registrationId = `TDEXPOUP-${String(nextId).padStart(4, '0')}`;

    const [uploadProfileResponse, uploadPaymentResponse] = await Promise.all([
      uploadToCloudinary(profileImage.content, "expo-profile-images-2025"),
      uploadToCloudinary(paymentScreenshot.content, "expo-payments-2025")
    ]);

    const newRegistrationData = {
      registrationId, name, phone, firmName, address, district, state, attendance,
      paymentScreenshotUrl: uploadPaymentResponse.secure_url,
      profileImageUrl: uploadProfileResponse.secure_url,
      createdAt: FieldValue.serverTimestamp()
    };

    await registrationsRef.doc(phone).set(newRegistrationData);

    // --- Google Sheets Sync (unchanged logic, but uses initialized auth) ---
    try {
      const sheets = google.sheets({ version: 'v4', auth: googleAuth });
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Registrations!A1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[ /* Data... */ new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), registrationId, name, phone, firmName, address, district, state, attendance, newRegistrationData.paymentScreenshotUrl, newRegistrationData.profileImageUrl]],
        },
      });
    } catch (sheetError) {
      console.error('GOOGLE_SHEET_SYNC_ERROR:', sheetError.message);
    }

    return {
      statusCode: 200,
      body: JSON.stringify(newRegistrationData),
    };

  } catch (error) {
    console.error('REGISTRATION_ERROR:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `An unexpected error occurred: ${error.message}` }),
    };
  }
};
