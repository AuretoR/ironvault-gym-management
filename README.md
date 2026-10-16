# IronVault Gym Management System

A full-stack starter project for a premium gym website and admin system.

## Stack
- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js + Express
- Database: MySQL
- Authentication: server-side sessions + bcrypt password hashing
- Charts: Chart.js (loaded from CDN)

## Requirements
- Node.js 20+
- MySQL 8+

## Setup
1. Create a MySQL database and import `database/schema.sql`.
2. Copy `.env.example` to `.env` and set your database/session values.
3. Install dependencies: `npm install`
4. Create the first admin: `npm run create-admin`
5. Start the server: `npm run dev`
6. Open `http://localhost:3000`

The initial admin is created from `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in `.env`. Do not use a weak password.

## What is implemented
- Responsive premium public website
- Registration form connected to the API
- Secure admin login/logout using sessions
- Dashboard totals based on MySQL records
- Member list, search, status filter, add member, member detail, edit and archive
- Membership plan list and admin price editing
- Automatic date-based membership status calculation
- Renewal endpoint that preserves active membership validity
- Payment recording, partial balances, and payment history
- Follow-up records
- Reminder queue table and a safe reminder scheduler stub
- CSV export
- BMI calculator, FAQ, gallery lightbox, theme toggle
- Basic automated tests

## Not yet live without configuration
- Email/WhatsApp/SMS delivery: reminders are queued, not falsely marked sent. Configure an authorized provider and implement its delivery adapter.
- Online payments: no payment gateway is configured. Admin-recorded payments are manual records, not gateway-verified transactions.
- Production deployment, domain, TLS, backups, and provider credentials must be configured for the target host.

## Important date rule
Membership statuses are computed using the server's configured `TZ`. Expiry dates are treated as inclusive: a membership ending today remains valid through today. "Expiring soon" means today through the next 6 calendar days.

## Security notes before production
- Use HTTPS and a strong unique session secret.
- Set `NODE_ENV=production` behind HTTPS so secure cookies are enabled.
- Add a real email/SMS/WhatsApp provider before enabling outbound reminders.
- Configure regular encrypted database backups and test restoration.
- Review applicable privacy, consent, data retention and payment rules.

## Membership reminders tab

The admin Reminders tab is a live, database-backed expiry worklist (not a message queue). It shows the latest membership per non-archived member and filters members into:

- Expiring in 1–7 days
- Expires today
- Expired

The tab includes counts, search by member name/phone/member code/plan, a status filter, and a refresh button. It recalculates the list when opened/refreshed and does not send WhatsApp, SMS, or email messages. No scheduled job or messaging provider is needed for this list view.
