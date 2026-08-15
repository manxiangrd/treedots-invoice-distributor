const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// Environment variables
const TREEDOTS_TOKEN = process.env.TREEDOTS_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const MAYTAPI_API_KEY = process.env.MAYTAPI_API_KEY;
const MAYTAPI_PRODUCT_ID = process.env.MAYTAPI_PRODUCT_ID || '939093020-643a-4ce9-9541-e8663e454955';
const MAYTAPI_PHONE_ID = process.env.MAYTAPI_PHONE_ID || '149443';

// TreeDots API
const TREEDOTS_API_URL = 'https://external-api.eai-lab.com/mcp';

// Maytapi API
const MAYTAPI_API_URL = 'https://api.maytapi.com/api/2.0/sendMessage';

/**
 * Get invoices from TreeDots for today
 */
async function getInvoicesFromTreeDots() {
  try {
    console.log('Fetching invoices from TreeDots...');
    
    const response = await axios.post(
      `${TREEDOTS_API_URL}?token=${TREEDOTS_TOKEN}`,
      {
        selectFrom: 'invoices',
        select: 'all',
        where: [
          ['invoices.created_at', '>=', new Date().toISOString().split('T')[0] + 'T00:00:00'],
          ['invoices.created_at', '<=', new Date().toISOString().split('T')[0] + 'T23:59:59']
        ],
        orderBy: [['invoices.created_at', 'desc']]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        }
      }
    );

    const invoices = response.data;
    console.log(`Found ${invoices.length} invoices for today`);
    return invoices;
  } catch (error) {
    console.error('Error fetching invoices from TreeDots:', error.message);
    throw error;
  }
}

/**
 * Get outlet mapping from Google Sheet
 */
async function getOutletMappingFromSheet() {
  try {
    console.log('Fetching outlet mapping from Google Sheet...');
    
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, { apiKey: GOOGLE_API_KEY });
    await doc.loadInfo();
    
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    const mapping = {};
    rows.forEach(row => {
      const outletCode = row.get('Group Chat Purpose') || row.get('A');
      const groupId = row.get('Group Chat ID') || row.get('C');
      const customerIdentifier = row.get('TreeDots Outlet Identifier/Customer Name') || row.get('D');
      
      if (customerIdentifier && groupId) {
        mapping[customerIdentifier] = {
          outletCode,
          groupId
        };
      }
    });
    
    console.log(`Loaded ${Object.keys(mapping).length} outlet mappings`);
    return mapping;
  } catch (error) {
    console.error('Error fetching outlet mapping from Google Sheet:', error.message);
    throw error;
  }
}

/**
 * Find matching outlet for invoice
 */
function findMatchingOutlet(invoice, outletMapping) {
  const companyName = invoice.company_name || invoice.customer_name || '';
  
  for (const [customerIdentifier, outlet] of Object.entries(outletMapping)) {
    // Extract the part after the bracket (e.g., "631BR 烧腊" from "[B2639401] 631BR 烧腊")
    const identifierPart = customerIdentifier.split(']')[1]?.trim() || customerIdentifier;
    
    if (companyName.includes(identifierPart) || identifierPart.includes(companyName)) {
      return outlet;
    }
  }
  
  return null;
}

/**
 * Send invoice to WhatsApp group
 */
async function sendInvoiceToWhatsApp(invoice, outlet) {
  try {
    console.log(`Sending invoice ${invoice.invoice_number} to outlet ${outlet.outletCode}...`);
    
    const payload = {
      product_id: MAYTAPI_PRODUCT_ID,
      phone_id: parseInt(MAYTAPI_PHONE_ID),
      to: outlet.groupId,
      type: 'media',
      media: {
        type: 'document',
        link: invoice.pdf_url || 'https://example.com/invoice.pdf',
        caption: `📄 Invoice ${invoice.invoice_number}\n🏪 Outlet: ${outlet.outletCode}\n💰 Amount: $${invoice.amount || 0}`
      }
    };
    
    const response = await axios.post(MAYTAPI_API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${MAYTAPI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`✅ Invoice ${invoice.invoice_number} sent successfully to ${outlet.outletCode}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send invoice ${invoice.invoice_number}:`, error.message);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('=== Starting Daily Invoice Distribution ===');
    console.log(`Time: ${new Date().toISOString()}`);
    
    // Validate environment variables
    if (!TREEDOTS_TOKEN || !GOOGLE_SHEET_ID || !GOOGLE_API_KEY || !MAYTAPI_API_KEY) {
      throw new Error('Missing required environment variables');
    }
    
    // Get invoices and outlet mapping
    const invoices = await getInvoicesFromTreeDots();
    const outletMapping = await getOutletMappingFromSheet();
    
    if (invoices.length === 0) {
      console.log('No invoices found for today. Exiting.');
      return;
    }
    
    // Process each invoice
    let successCount = 0;
    let failureCount = 0;
    
    for (const invoice of invoices) {
      const outlet = findMatchingOutlet(invoice, outletMapping);
      
      if (!outlet) {
        console.warn(`⚠️  No matching outlet found for invoice ${invoice.invoice_number} (${invoice.company_name})`);
        failureCount++;
        continue;
      }
      
      const sent = await sendInvoiceToWhatsApp(invoice, outlet);
      if (sent) {
        successCount++;
      } else {
        failureCount++;
      }
    }
    
    console.log(`\n=== Summary ===`);
    console.log(`Total invoices: ${invoices.length}`);
    console.log(`Successfully sent: ${successCount}`);
    console.log(`Failed: ${failureCount}`);
    console.log(`Unmatched: ${invoices.length - successCount - failureCount}`);
    console.log('=== Finished ===\n');
    
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
