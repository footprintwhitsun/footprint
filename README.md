# Footprint Enterprise POS & Commerce OS

A modern, high-velocity Point of Sale (POS) and Enterprise Resource Planning (ERP) platform built with Node.js, Express, PostgreSQL, and Shopify Polaris design aesthetics.

## Features

- **Shopify Polaris POS Terminal**: Fast-paced offline-resilient register with camera barcode scanner, live inventory lookup, split tender, and thermal receipt printing.
- **Inventory & Multi-Branch Management**: Stock tracking, low stock alerts, purchase orders, goods receiving, and negative stock controls.
- **Financial Telemetry & Analytics**: Real-time sales dashboards, profitability reports, tax compliance management (VAT, NHIL, GETFund), and end-of-shift reconciliation.
- **Enterprise RBAC**: Multi-tier access governance tailored for CEO, Admin, Store Manager, Cashier, and B2B Corporate Clients.
- **B2B Corporate Portal**: Client invoice generation, proforma invoices, and balance ledger tracking.
- **Customer Facing Display**: Dual-screen real-time transaction display with store promotional tickers.

## Prerequisites

- Node.js (v18 or higher)
- PostgreSQL Database (e.g. Supabase, Neon, or local instance)

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/whitsun/footprint-pos.git
   cd whitsun-footprint
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment:
   ```bash
   cp .env.example .env
   ```
   Configure `PORT`, `DATABASE_URL`, `JWT_SECRET`, and SMTP credentials in `.env`.

4. Start the application:
   ```bash
   npm start
   # or for development
   npm run dev
   ```
   Default server runs on `http://localhost:8080`.

## Architecture & Deployment

- **Server**: Express.js with connection pooling (`pg`), Helmet security headers, rate limiting, and compression.
- **Frontend**: Vanilla JS and CSS tokens following Shopify Polaris guidelines.
- **Offline Resilience**: Service Worker and local IndexedDB queuing for uninterrupted offline sales.
- **Deployment**: Ready for Vercel, Railway, Render, or VPS deployment.

## License

Private & Confidential - © 2026 Footprint. All rights reserved.