// /netlify/functions/export-data.js

const { pool } = require("./utils");

exports.handler = async (event, context) => {
  // Simple secret key authentication
  const providedKey = event.headers['x-admin-key'];
  const secretKey = process.env.EXPORT_SECRET_KEY;

  if (!providedKey || providedKey !== secretKey) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }

  try {
    const client = await pool.connect();
    const { rows } = await client.query('SELECT registration_id, name, company, phone, address, city, state, day, payment_id, timestamp, image_url FROM registrations ORDER BY timestamp DESC');
    client.release();

    // Convert JSON to CSV
    const headers = ["Registration ID", "Name", "Company", "Phone", "Address", "City", "State", "Days Attending", "Payment ID", "Timestamp", "Image URL"];
    const csvRows = [headers.join(',')];

    rows.forEach(row => {
      // Escape commas within fields by enclosing in double quotes
      const values = headers.map((header, index) => {
        const key = header.toLowerCase().replace(/ /g, '_');
        let value = row[key] ? row[key].toString() : '';
        // If a value contains a comma, quote it
        if (value.includes(',')) {
          value = `"${value}"`;
        }
        return value;
      });
      csvRows.push(values.join(','));
    });

    const csvData = csvRows.join('\n');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="tent-expo-registrations-${new Date().toISOString()}.csv"`,
      },
      body: csvData,
    };

  } catch (error) {
    console.error("Error exporting data:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to export data." }),
    };
  }
};