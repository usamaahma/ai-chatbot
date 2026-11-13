const { GoogleGenAI } = require('@google/genai');
const {
  buildSystemInstruction,
  SUBMIT_QUOTE_DECLARATION,
  SAVE_CONTACT_DECLARATION,
  REQUEST_HUMAN_DECLARATION,
  FLAG_UNANSWERED_DECLARATION,
} = require('./systemPrompt');
const { makeRedactor } = require('./redact');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Primary + fallbacks. Gemini's free tier meters requests PER MODEL PER DAY, so
// a chain of models multiplies the free daily headroom. "lite" models have the
// largest free quotas and are plenty for a sales chatbot.
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS ||
  'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-latest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODEL_CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];

const MAX_OUTPUT_TOKENS = 1200;
const MAX_TOOL_ROUNDS = 3;
// Per-attempt time limits. The primary answers in ~1s, so give up on it fast
// when it hangs; the fallbacks are slower (normally 2-7s), so they get longer.
const PRIMARY_TIMEOUT_MS = 6000;
const FALLBACK_TIMEOUT_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Keep only contact details the visitor actually typed (or said) in the chat.
// The model sometimes "saves" details after a visitor merely says "I gave it",
// or fills in a guessed value - never store anything that isn't in their words.
function verifiedContact(args, history) {
  const said = history.filter((m) => m.role === 'user').map((m) => m.content).join('\n').toLowerCase();
  const saidDigits = said.replace(/\D/g, '');
  const out = {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  // Voice typing writes emails as "ali khan at gmail dot com": compare against
  // a version with spoken "at"/"dot" turned into symbols and spaces removed.
  const saidCompact = said
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+/g, '');
  const email = str(args.email).toLowerCase();
  if (email && EMAIL_RE.test(email) && (said.includes(email) || saidCompact.includes(email))) out.email = email;

  const phoneDigits = str(args.phone).replace(/\D/g, '');
  if (phoneDigits.length >= 7 && saidDigits.includes(phoneDigits)) out.phone = str(args.phone);

  for (const key of ['name', 'customerName', 'company']) {
    const v = str(args[key]);
    if (v && said.includes(v.toLowerCase())) out[key] = v;
  }
  return out;
}

// Emails and phone numbers are replaced with placeholders before anything is
// sent to Gemini (see redact.js); the real values never leave our server.
function toContents(history, redactor) {
  return history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: redactor.redact(m.content) }],
  }));
}

function baseConfig(context) {
  return {
    systemInstruction: buildSystemInstruction(context),
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // The visitor is always asked for details in the chat, never sent a form,
    // so show_lead_form is intentionally not offered to the model.
    tools: [{ functionDeclarations: [SUBMIT_QUOTE_DECLARATION, SAVE_CONTACT_DECLARATION, REQUEST_HUMAN_DECLARATION, FLAG_UNANSWERED_DECLARATION] }],
  };
}

// Try each model in the chain. 429 (daily quota) or persistent 503 -> next model.
// Returns { response, model }. Throws only if the whole chain is exhausted.
async function generateAcrossChain(contents, startModel, context) {
  const chain = startModel ? [startModel] : MODEL_CHAIN;
  let lastErr;

  for (const model of chain) {
    const timeoutMs = model === PRIMARY_MODEL && !startModel ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // An overloaded model can hang for 10s+; cut it off and move on.
        const config = { ...baseConfig(context), abortSignal: AbortSignal.timeout(timeoutMs) };
        const response = await ai.models.generateContent({ model, contents, config });
        return { response, model };
      } catch (err) {
        lastErr = err;
        const status = err?.status;
        if (status === 503 && attempt === 0) {
          await sleep(300);
          continue; // retry same model once
        }
        break; // timeout / 429 / 400 / other -> move to next model
      }
    }
  }
  throw lastErr;
}

/**
 * Run one assistant turn.
 * @param {Array<{role:'user'|'assistant', content:string}>} history
 * @param {{pageUrl?:string, visitor?:{name?:string,email?:string,phone?:string}}} [context]
 * @returns {Promise<{ reply: string, order: object|null, contact: object|null, escalations: object[], showLeadForm: boolean }>}
 */
async function runAssistantTurn(history, context) {
  const redactor = makeRedactor();
  const contents = toContents(history, redactor);
  let capturedOrder = null;
  let capturedContact = null;
  const escalations = []; // { reason, question, detail, priority } for the "Needs attention" inbox
  let showLeadForm = false;
  // Every way out of this function: real emails/phones back in the reply text.
  const done = (reply) => ({
    reply: redactor.restore(reply),
    order: capturedOrder,
    contact: capturedContact,
    escalations,
    showLeadForm,
  });
  let activeModel = null; // lock to one model for the whole tool loop (thought signatures are model-bound)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response, model;
    try {
      ({ response, model } = await generateAcrossChain(contents, activeModel, context));
    } catch (err) {
      // The follow-up call after a tool call can only use the same model. If it
      // fails, the details are already captured - answer with a stock line
      // instead of failing the whole turn.
      if (round > 0 && (capturedOrder || capturedContact)) {
        console.warn('Follow-up after tool call failed, using fallback reply:', err?.name || err?.status);
        return done(
          capturedOrder
            ? 'Sure, I will email you the price quote and we can move further from there\nIs there anything else I can assist you with?'
            : 'Thank you for sharing the information with me.'
        );
      }
      if (round > 0 && escalations.length) {
        return done('Thank you, I have passed this to our team and a team member will get back to you shortly.');
      }
      throw err;
    }
    activeModel = model;

    const calls = response.functionCalls || [];

    if (calls.length === 0) {
      const text = (response.text || '').trim();
      if (text) return done(text);

      const blocked =
        response.promptFeedback?.blockReason || response.candidates?.[0]?.finishReason;
      if (blocked && blocked !== 'STOP') {
        return done("Sorry, I can't help with that. If it's about your printing or an order, I'm happy to keep going.");
      }
      return done('Sorry, could you say that again?');
    }

    // Echo the model's turn back verbatim (preserves thoughtSignature on 3.x models).
    const modelContent = response.candidates?.[0]?.content;
    contents.push(
      modelContent || {
        role: 'model',
        parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
      }
    );

    const responseParts = [];
    for (const call of calls) {
      const name = call.name || '';
      const realArgs = redactor.restoreDeep(call.args || {});
      if (name === 'submit_quote_request' || name.endsWith(':submit_quote_request')) {
        const args = { ...realArgs };
        const typed = verifiedContact(args, history);
        const email = typed.email || context?.visitor?.email || null;
        if (!email) {
          responseParts.push({
            functionResponse: {
              name: call.name,
              response: {
                error:
                  'NOT SENT: the visitor has not typed an email address in this chat yet (saying "I gave it" or "given" is not an email). Do not thank them or say the quote is on its way. Politely say you did not receive it and ask them to type their email address.',
              },
            },
          });
          continue;
        }
        args.email = email;
        args.customerName = typed.customerName || typed.name || null;
        args.phone = typed.phone || null;
        args.company = typed.company || null;
        capturedOrder = args;
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: 'Quote request sent to the estimate department. The official quote will be emailed to the visitor.' },
          },
        });
      } else if (name === 'save_contact_details' || name.endsWith(':save_contact_details')) {
        const typed = verifiedContact(realArgs, history);
        if (!Object.keys(typed).length) {
          responseParts.push({
            functionResponse: {
              name: call.name,
              response: {
                error:
                  'NOTHING SAVED: no name, phone number or email appears in what the visitor actually wrote. Do not thank them for their details. Politely say you did not receive them and ask them to type them, at least their email for the quote.',
              },
            },
          });
          continue;
        }
        capturedContact = { ...(capturedContact || {}), ...typed };
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: `Saved for the sales team: ${Object.keys(typed).join(', ')}.` },
          },
        });
      } else if (name === 'request_human' || name.endsWith(':request_human')) {
        escalations.push({ reason: 'visitor_requested_human', detail: String(realArgs.reason || '').slice(0, 500) || null, priority: 1 });
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: {
              result:
                'The team has been notified. Tell the visitor a team member will get back to them shortly. If you do not have their email or phone number yet, ask for it so the team can reach them.',
            },
          },
        });
      } else if (name === 'flag_unanswered' || name.endsWith(':flag_unanswered')) {
        const complaint = realArgs.kind === 'complaint';
        escalations.push({
          reason: complaint ? 'complaint' : 'unanswered_question',
          question: String(realArgs.question || '').slice(0, 500) || null,
          priority: complaint ? 1 : 2,
        });
        responseParts.push({
          functionResponse: { name: call.name, response: { result: 'Flagged for the team. Continue the conversation normally.' } },
        });
      } else if (name === 'show_lead_form' || name.endsWith(':show_lead_form')) {
        showLeadForm = true;
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: 'The contact form is now open in the widget for the visitor to fill in.' },
          },
        });
      } else {
        responseParts.push({
          functionResponse: { name: call.name, response: { error: 'Unknown function' } },
        });
      }
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  // Tool rounds exhausted without a text reply: don't claim anything was saved.
  return done(
    capturedOrder
      ? 'Thank you, I will email you the official price quote shortly\nIs there anything else I can help you with?'
      : capturedContact
        ? 'Thank you for sharing the information with me.'
        : escalations.length
          ? 'Thank you, I have passed this to our team and a team member will get back to you shortly.'
          : 'Sorry, I did not receive your email address\nCould you please type it here so I can send you the price quote?'
  );
}

/**
 * Plain text generation (no tools, no chat persona), e.g. summarising a
 * company's website into a knowledge sheet. Falls through the model chain.
 */
async function generateText(prompt, { timeoutMs = 45000, maxOutputTokens = 2000 } = {}) {
  let lastErr;
  for (const model of MODEL_CHAIN) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { temperature: 0.2, maxOutputTokens, abortSignal: AbortSignal.timeout(timeoutMs) },
      });
      const text = (response.text || '').trim();
      if (text) return text;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No text returned');
}

module.exports = { runAssistantTurn, generateText, MODEL_CHAIN };
