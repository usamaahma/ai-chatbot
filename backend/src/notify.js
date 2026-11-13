const nodemailer = require('nodemailer');

// Email alerts to the website owner: new lead, new quote request, and chats
// that need a person. Sent through any SMTP account (Gmail app password,
// Hostinger / cPanel mailbox, etc.) configured in .env. Without SMTP settings
// alerts are simply skipped.

let transport = null;
let warned = false;

function getTransport() {
  if (transport) return transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    if (!warned) console.warn('Email alerts are off: set SMTP_HOST, SMTP_USER and SMTP_PASS in .env to turn them on.');
    warned = true;
    return null;
  }
  const port = Number(SMTP_PORT) || 465;
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  return transport;
}

const splitList = (s) => String(s || '').split(/[,\s;]+/).map((x) => x.trim()).filter((x) => /@/.test(x));

// Who hears about this company's chats.
function recipients(company) {
  const list = splitList(company?.notifyEmails);
  if (list.length) return list;
  const fallback = splitList(process.env.ALERT_EMAILS);
  if (fallback.length) return fallback;
  return splitList(company?.salesEmail || company?.email);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const adminUrl = () => `${(process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/admin`;

function render(title, rows, note) {
  const filled = rows.filter(([, v]) => v != null && v !== '' && v !== false);
  const text = [title, '', ...filled.map(([k, v]) => `${k}: ${v}`), '', note || '', `Open the dashboard: ${adminUrl()}`].join('\n');
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;max-width:560px">
<h2 style="font-size:17px;margin:0 0 12px">${esc(title)}</h2>
<table style="border-collapse:collapse">${filled
    .map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#64748b;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`)
    .join('')}</table>
${note ? `<p style="margin:14px 0 0">${esc(note)}</p>` : ''}
<p style="margin:16px 0 0"><a href="${esc(adminUrl())}" style="color:#4f46e5">Open the dashboard</a></p></div>`;
  return { text, html };
}

async function send(company, subject, body) {
  const t = getTransport();
  const to = recipients(company);
  if (!t || !to.length) return false;
  const from = process.env.ALERT_FROM || `"${company?.chatbotName || 'Chatbot'} alerts" <${process.env.SMTP_USER}>`;
  await t.sendMail({ from, to: to.join(', '), subject, text: body.text, html: body.html });
  return true;
}

// Alerts must never break or slow the chat. On a long-running server they go out
// in the background; on Vercel the function may freeze after responding, so
// there the caller awaits this (with a time limit) before replying.
function deliver(promise) {
  const safe = Promise.race([promise, new Promise((r) => setTimeout(r, 8000))]).catch((err) =>
    console.error('Email alert failed:', err.message)
  );
  return process.env.VERCEL ? safe : undefined;
}

const REASONS = {
  visitor_requested_human: 'Visitor asked for a real person',
  complaint: 'Complaint or problem with an order',
  unanswered_question: "The chatbot couldn't answer",
  ai_failure: 'The chatbot failed to reply',
  repeated_misunderstanding: "The chatbot kept not understanding",
  lead_not_captured: 'Visitor left without leaving an email',
};

function notifyLead(company, lead) {
  const site = company?.companyName || 'your website';
  return deliver(
    send(
      company,
      `New lead on ${site}: ${lead.name || lead.email || lead.phone}`,
      render(`New lead from the ${site} chatbot`, [
        ['Name', lead.name],
        ['Email', lead.email],
        ['Phone', lead.phone],
        ['Message', lead.message],
        ['Source', lead.source === 'manual' ? 'callback form' : 'shared in chat'],
        ['Chat ID', lead.conversationPublicId],
      ])
    )
  );
}

function notifyQuote(company, order) {
  const site = company?.companyName || 'your website';
  return deliver(
    send(
      company,
      `New quote request on ${site}: ${order.quantity || ''} ${order.boxType || 'boxes'}`.replace(/\s+/g, ' '),
      render(
        `New quote request from the ${site} chatbot`,
        [
          ['Customer', order.customerName],
          ['Email', order.email],
          ['Phone', order.phone],
          ['Company', order.company],
          ['Box', order.boxType],
          ['Style', order.style],
          ['Size', order.dimensions],
          ['Quantity', order.quantity],
          ['Material', order.material],
          ['Printing', order.printing],
          ['Finish', order.finish],
          ['Inserts', order.inserts],
          ['Artwork', order.artworkStatus],
          ['Sample', order.sampleRequested ? 'requested' : null],
          ['Notes', order.notes],
          ['Page', order.pageUrl],
          ['Chat ID', order.conversationPublicId],
        ],
        'The customer was told the official price quote will be emailed to them.'
      )
    )
  );
}

function notifyEscalation(company, esc_, visitor) {
  const site = company?.companyName || 'your website';
  const v = visitor || {};
  return deliver(
    send(
      company,
      `Needs attention on ${site}: ${REASONS[esc_.reason] || esc_.reason}`,
      render(`A chat on ${site} needs a person`, [
        ['Why', REASONS[esc_.reason] || esc_.reason],
        ['Question', esc_.question],
        ['Details', esc_.detail],
        ['Visitor', v.name],
        ['Email', v.email],
        ['Phone', v.phone],
        ['Chat ID', esc_.conversationPublicId],
      ])
    )
  );
}

module.exports = { notifyLead, notifyQuote, notifyEscalation, REASONS, recipients };
