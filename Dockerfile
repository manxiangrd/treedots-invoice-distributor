# Use pre-built Puppeteer image (has Chrome + Node included)
FROM buildkite/puppeteer:latest

# Set working directory
WORKDIR /app

# Copy application files
COPY package*.json ./
COPY send-invoices-puppeteer.js .

# Install Node dependencies
RUN npm install --production

# Run the script
CMD ["node", "send-invoices-puppeteer.js"]
