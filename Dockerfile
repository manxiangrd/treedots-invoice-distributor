# Use official Node.js image as base
FROM node:18-slim

# Install Chromium and dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium-browser \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies (Puppeteer will use system Chromium)
RUN npm install

# Copy application files
COPY send-invoices-puppeteer.js .

# Run the script
CMD ["node", "send-invoices-puppeteer.js"]
