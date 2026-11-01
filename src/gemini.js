// Minimal client for the Gemini API (generativelanguage.googleapis.com).
// Calls are made directly from the browser with the user's own API key.

export const MODEL = 'gemini-3.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

function friendlyError(status, apiMessage) {
  if (status === 400 && /api key/i.test(apiMessage ?? '')) {
    return 'Your Gemini API key looks invalid. Please check it and try again.';
  }
  if (status === 401 || status === 403) {
    return 'Your Gemini API key was rejected. Make sure it is valid and has access to the Gemini API.';
  }
  if (status === 404) {
    return `The model "${MODEL}" was not found for this API key. (${apiMessage ?? 'Not found'})`;
  }
  if (status === 429) {
    return 'Rate limit or quota exceeded for this API key. Wait a moment and try again.';
  }
  if (status >= 500) {
    return 'Gemini is having trouble right now. Please try again in a moment.';
  }
  return apiMessage || `Request failed with status ${status}.`;
}

async function post(method, { apiKey, body, signal, query = '' }) {
  const url = `${API_BASE}/models/${encodeURIComponent(MODEL)}:${method}${query}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let apiMessage;
    try {
      apiMessage = (await res.json())?.error?.message;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new GeminiError(friendlyError(res.status, apiMessage), res.status);
  }
  return res;
}

const textOf = (json) =>
  (json?.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');

/**
 * Stream a chat response from Gemini.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.system           System instruction (role persona).
 * @param {{role: 'user'|'model', text: string}[]} opts.history  Full conversation, ending with the latest user turn.
 * @param {(chunk: string) => void} opts.onChunk  Called with each new text fragment.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} The full response text.
 */
export async function streamChat({ apiKey, system, history, onChunk, signal }) {
  const res = await post('streamGenerateContent', {
    apiKey,
    signal,
    query: '?alt=sse',
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      generationConfig: { temperature: 0.8 },
    },
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const handleEvent = (raw) => {
    const payload = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!payload || payload === '[DONE]') return;

    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) {
      throw new GeminiError(json.error.message || 'Gemini returned an error.', json.error.code);
    }
    const text = textOf(json);
    if (text) {
      full += text;
      onChunk?.(text);
    }
    if (!full && json.promptFeedback?.blockReason) {
      throw new GeminiError(`The request was blocked (${json.promptFeedback.blockReason}). Try rephrasing.`);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleEvent(event);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleEvent(buffer);

  if (!full) {
    throw new GeminiError('Gemini returned an empty response. Please try again.');
  }
  return full;
}

/**
 * Ask Gemini for a JSON response that follows `schema`.
 * @returns {Promise<any>} The parsed JSON value.
 */
export async function generateJSON({ apiKey, system, prompt, schema, signal, temperature = 0.9 }) {
  const res = await post('generateContent', {
    apiKey,
    signal,
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    },
  });

  const json = await res.json();
  if (json.promptFeedback?.blockReason) {
    throw new GeminiError(`The request was blocked (${json.promptFeedback.blockReason}).`);
  }
  const text = textOf(json)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  if (!text) throw new GeminiError('Gemini returned an empty response. Please try again.');
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError('Gemini returned a malformed quiz. Please try again.');
  }
}
