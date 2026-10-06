const { GoogleGenAI } = require('@google/genai');
const {
  buildSystemInstruction,
  SUBMIT_QUOTE_DECLARATION,
  SAVE_CONTACT_DECLARATION,
} = require('./systemPrompt');

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

function toContents(history) {
  return history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

function baseConfig(context) {
  return {
    systemInstruction: buildSystemInstruction(context),
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // The visitor is always asked for details in the chat, never sent a form,
    // so show_lead_form is intentionally not offered to the model.
    tools: [{ functionDeclarations: [SUBMIT_QUOTE_DECLARATION, SAVE_CONTACT_DECLARATION] }],
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
 * @returns {Promise<{ reply: string, order: object|null, contact: object|null, showLeadForm: boolean }>}
 */
async function runAssistantTurn(history, context) {
  const contents = toContents(history);
  let capturedOrder = null;
  let capturedContact = null;
  let showLeadForm = false;
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
        return {
          reply: capturedOrder
            ? 'Sure, I will email you the price quote and we can move further from there\nIs there anything else I can assist you with?'
            : 'Thank you for sharing the information with me.',
          order: capturedOrder,
          contact: capturedContact,
          showLeadForm,
        };
      }
      throw err;
    }
    activeModel = model;

    const calls = response.functionCalls || [];

    if (calls.length === 0) {
      const text = (response.text || '').trim();
      if (text) return { reply: text, order: capturedOrder, contact: capturedContact, showLeadForm };

      const blocked =
        response.promptFeedback?.blockReason || response.candidates?.[0]?.finishReason;
      if (blocked && blocked !== 'STOP') {
        return {
          reply:
            "Sorry, I can't help with that. If it's about your printing or an order, I'm happy to keep going.",
          order: capturedOrder,
          contact: capturedContact,
          showLeadForm,
        };
      }
      return { reply: 'Sorry, could you say that again?', order: capturedOrder, contact: capturedContact, showLeadForm };
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
      if (name === 'submit_quote_request' || name.endsWith(':submit_quote_request')) {
        capturedOrder = call.args || {};
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: 'Quote request sent to the estimate department. The official quote will be emailed to the visitor.' },
          },
        });
      } else if (name === 'save_contact_details' || name.endsWith(':save_contact_details')) {
        capturedContact = { ...(capturedContact || {}), ...(call.args || {}) };
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: 'Contact details saved for the sales team.' },
          },
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

  return {
    reply: 'Thanks! Your details are recorded and a team member will contact you shortly.',
    order: capturedOrder,
    contact: capturedContact,
    showLeadForm,
  };
}

module.exports = { runAssistantTurn, MODEL_CHAIN };
