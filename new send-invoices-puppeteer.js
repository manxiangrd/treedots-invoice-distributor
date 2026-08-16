const puppeteer = require('puppeteer');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// Environment variables
const PORTAL_URL = 'http://supplier-dashboard.eai-lab.com/';
const PORTAL_USERNAME = process.env.PORTAL_USERNAME;
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const MAYTAPI_API_KEY = process.env.MAYTAPI_API_KEY;
const MAYTAPI_PRODUCT_ID = process.env.MAYTAPI_PRODUCT_ID || '939093020-643a-4ce9-9541-e8663e454955';
const MAYTAPI_PHONE_ID = process.env.MAYTAPI_PHONE_ID || '149443';

const MAYTAPI_API_URL = 'https://api.maytapi.com/api/2.0/sendMessage';

/**
 * Login to TreeDots portal and fetch invoices
 */
async function getInvoicesFromPortal() {
  let browser;
  try {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });
    
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    
    console.log('Navigating to portal...');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle2' });
    
    // Login
    console.log('Logging in...');
    await page.waitForSelector('input[placeholder="Username"]', { timeout: 10000 });
    await page.type('input[placeholder="Username"]', PORTAL_USERNAME, { delay: 50 });
    await page.type('input[placeholder="Password"]', PORTAL_PASSWORD, { delay: 50 });
    
    // Click the Sign In button
    await page.click('button:contains("Sign In")');
    
    // Wait for navigation after login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log('Login successful');
    
    // Navigate to Finance > Invoices
    console.log('Navigating to invoices page...');
    await page.goto(`${PORTAL_URL}main/finance/invoices`, { waitUntil: 'networkidle2' });
    
    // Wait for invoice table to load
    await page.waitForSelector('table tbody tr', { timeout: 30000 });
    
    // Extract invoice data
    const invoices = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const invoices = [];
      
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length > 0) {
          const invoiceNumber = cells[0]?.innerText?.trim() || '';
          const orderNumber = cells[1]?.innerText?.trim() || '';
          const customer = cells[2]?.innerText?.trim() || '';
          const date = cells[3]?.innerText?.trim() || '';
          const amount = cells[4]?.innerText?.trim() || '0';
          
          // Check if created today (simple date check)
          const today = new Date().toLocaleDateString('en-GB').replace(/\//g, ' ');
          
          if (invoiceNumber && customer) {
            invoices.push({
              invoiceNumber,
              orderNumber,
              customer,
              date,
              amount: parseFloat(amount.replace(/[^0-9.-]+/g, '')) || 0,
              createdToday: date.includes(new Date().getDate().toString())
            });
          }
        }
      });
      
      return invoices;
    });
    
    await browser.close();
    
    // Filter only today's invoices
    const todayInvoices = invoices.filter(inv => inv.createdToday);
    console.log(`Found ${todayInvoices.length} invoices from today (out of ${invoices.length} total)`);
    
    return todayInvoices;
  } catch (error) {
    console.error('Error fetching invoices from portal:', error.message);
    if (browser) {
      await browser.close();
    }
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
  const customerName = invoice.customer || '';
  
  for (const [customerIdentifier, outlet] of Object.entries(outletMapping)) {
    // Extract the part after the bracket (e.g., "631BR 烧腊" from "[B2639401] 631BR 烧腊")
    const identifierPart = customerIdentifier.split(']')[1]?.trim() || customerIdentifier;
    
    if (customerName.includes(identifierPart) || identifierPart.includes(customerName)) {
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
    console.log(`Sending invoice ${invoice.invoiceNumber} to outlet ${outlet.outletCode}...`);
    
    const payload = {
      product_id: MAYTAPI_PRODUCT_ID,
      phone_id: parseInt(MAYTAPI_PHONE_ID),
      to: outlet.groupId,
      type: 'media',
      media: {
        type: 'document',
        link: `${PORTAL_URL}invoices/${invoice.invoiceNumber}.pdf`,
        caption: `📄 Invoice ${invoice.invoiceNumber}\n🏪 Outlet: ${outlet.outletCode}\n💰 Amount: $${invoice.amount}\n📅 ${invoice.date}`
      }
    };
    
    const response = await axios.post(MAYTAPI_API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${MAYTAPI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`✅ Invoice ${invoice.invoiceNumber} sent successfully to ${outlet.outletCode}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send invoice ${invoice.invoiceNumber}:`, error.message);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('=== Starting Daily Invoice Distribution (Web Scraping) ===');
    console.log(`Time: ${new Date().toISOString()}`);
    
    // Validate environment variables
    if (!PORTAL_USERNAME || !PORTAL_PASSWORD || !GOOGLE_SHEET_ID || !GOOGLE_API_KEY || !MAYTAPI_API_KEY) {
      throw new Error('Missing required environment variables');
    }
    
    // Get invoices and outlet mapping
    const invoices = await getInvoicesFromPortal();
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
        console.warn(`⚠️  No matching outlet found for invoice ${invoice.invoiceNumber} (${invoice.customer})`);
        failureCount++;
        continue;
      }
      
      const sent = await sendInvoiceToWhatsApp(invoice, outlet);
      if (sent) {
        successCount++;
      } else {
        failureCount++;
      }
      
      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
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
