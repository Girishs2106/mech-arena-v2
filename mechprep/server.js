import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseDir = fileURLToPath(new URL('.', import.meta.url));
const root = join(baseDir, 'public');
const kgBankFile = join(root, 'data', 'knowledge-graph-bank.js');
const persistentStoreFile = join(root, 'data', 'persistent-syllabus-store.json');

try {
  for (const line of readFileSync(join(baseDir, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch {}

const port = Number(process.env.PORT || 3000);
const ollamaHost = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.txt':'text/plain; charset=utf-8' };

function readPersistentStore() {
  try {
    if (existsSync(persistentStoreFile)) {
      return JSON.parse(readFileSync(persistentStoreFile, 'utf8'));
    }
  } catch {}
  return { nodes: [], edges: [], questions: [], guides: [] };
}

function saveToPersistentKnowledgeGraph({ nodes = [], edges = [], questions = [], guides = [] }) {
  const store = readPersistentStore();
  store.nodes = store.nodes.concat(nodes);
  store.edges = store.edges.concat(edges);
  store.questions = store.questions.concat(questions);
  store.guides = store.guides.concat(guides);
  try {
    writeFileSync(persistentStoreFile, JSON.stringify(store, null, 2), 'utf8');
    // Also append directly to public/data/knowledge-graph-bank.js so every page load across all sessions gets the updated bank!
    const appendSnippet = `\n// --- Server-Persisted Syllabus Knowledge Graph Pack (${new Date().toISOString()}) ---\n(() => {\n  if (window.MECHPREP_KNOWLEDGE_GRAPH) {\n    window.MECHPREP_KNOWLEDGE_GRAPH.nodes.push(...${JSON.stringify(nodes)});\n    window.MECHPREP_KNOWLEDGE_GRAPH.edges.push(...${JSON.stringify(edges)});\n  }\n  window.MECHPREP_KG_QUESTIONS = (window.MECHPREP_KG_QUESTIONS || []).concat(${JSON.stringify(questions)});\n  window.MECHPREP_GENERATED_QUESTIONS = (window.MECHPREP_GENERATED_QUESTIONS || []).concat(${JSON.stringify(questions)});\n  window.MECHPREP_EXTRA_GUIDE = (window.MECHPREP_EXTRA_GUIDE || []).concat(${JSON.stringify(guides)});\n})();\n`;
    const currentKgJs = existsSync(kgBankFile) ? readFileSync(kgBankFile, 'utf8') : '';
    writeFileSync(kgBankFile, currentKgJs + appendSnippet, 'utf8');
  } catch {}
  return store;
}

async function ollamaStatus() {
  try {
    const response = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const data = await response.json();
    return (data.models || []).some(model => model.name === ollamaModel || model.name?.startsWith(`${ollamaModel}:`));
  } catch { return false; }
}

async function callLLM({ system, prompt, apiKey, jsonMode = false }) {
  const activeKey = apiKey || process.env.GEMINI_API_KEY;
  if (activeKey) {
    const generationConfig = { temperature: 0.25, maxOutputTokens: 3200 };
    if (jsonMode) generationConfig.responseMimeType = 'application/json';
    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig
    };
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': activeKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000)
    });
    const data = await upstream.json();
    if (!upstream.ok) throw new Error(data.error?.message || `Gemini request failed (${upstream.status}).`);
    return (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('\n').trim();
  } else {
    const payload = {
      model: ollamaModel,
      stream: false,
      ...(jsonMode ? { format: 'json' } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    };
    const upstream = await fetch(`${ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000)
    });
    const data = await upstream.json();
    if (!upstream.ok) throw new Error(data.error || `Local AI request failed (${upstream.status}).`);
    return data.message?.content || '';
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.url === '/api/health') {
    const localAI = await ollamaStatus();
    const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
    const store = readPersistentStore();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      aiAvailable: localAI || geminiConfigured,
      geminiConfigured,
      localAI,
      model: geminiConfigured ? geminiModel : ollamaModel,
      persistedQuestions: store.questions.length,
      persistedNodes: store.nodes.length
    }));
    return;
  }

  if (req.url === '/api/kg-bank' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readPersistentStore()));
    return;
  }

  if ((req.url === '/api/generate-from-pdf' || req.url === '/api/kg-ingest') && req.method === 'POST') {
    try {
      let raw = '';
      for await (const part of req) { raw += part; if (raw.length > 200000) throw new Error('Syllabus payload too large.'); }
      const { text, subject, count, apiKey, clientBuilt } = JSON.parse(raw);

      // If client already built or refined nodes/questions and wants to persist them to the global server bank:
      if (clientBuilt && Array.isArray(clientBuilt.questions)) {
        const saved = saveToPersistentKnowledgeGraph(clientBuilt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ persisted: true, totalQuestions: saved.questions.length, totalNodes: saved.nodes.length, ...clientBuilt }));
        return;
      }

      if (typeof text !== 'string' || text.trim().length < 20) throw new Error('Provide extracted syllabus text (at least 20 characters).');
      const numQ = Math.min(25, Math.max(4, Number(count) || 10));
      const system = 'You are the MechPrep Arena Knowledge-Graph Syllabus Architect & Question Bank Compiler. Parse engineering/aptitude syllabi into Knowledge Graph nodes, dependency edges, and multi-hop exam questions.';
      const prompt = `Convert the following uploaded syllabus / handout into a structured Knowledge Graph and Question Bank. Return ONLY valid JSON with keys:
"title" (string),
"nodes" (array of 3 to 6 objects, each with: "id" string, "code" string, "label" string, "domain" string, "parent" string, "bloom" string, "formula" string, "variables" string, "prereqs" array of strings, "concept" string, "trap" string, "source" string),
"guide" (object with keys: "title", "idea", "formula", "example", "method", "trap"),
"questions" (array of ${numQ} objects, each with keys: "kgNode" string, "topic" string, "difficulty" ("Basic"|"Intermediate"|"Advanced"), "text" string, "options" array of 4 strings, "answer" integer 0-3, "explain" step-by-step worked solution referencing the KG node and formula, "weightClass" ("short"|"problem")).
Subject focus: ${String(subject || 'Mechanical Engineering').slice(0, 80)}
Uploaded Syllabus Text:
${text.slice(0, 14000)}`;

      const replyText = await callLLM({ system, prompt, apiKey, jsonMode: true });
      const parsed = JSON.parse(replyText.replace(/^```json\s*|\s*```$/g, ''));
      if (Array.isArray(parsed.questions)) {
        saveToPersistentKnowledgeGraph({
          nodes: parsed.nodes || [],
          edges: [],
          questions: parsed.questions,
          guides: parsed.guide ? [parsed.guide] : []
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ persisted: true, ...parsed }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Server AI unavailable, using client KG compiler.' }));
    }
    return;
  }

  if (req.url === '/api/tutor' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const part of req) { raw += part; if (raw.length > 35000) throw new Error('Request too large.'); }
      const { question, topic, mode, kgContext, apiKey } = JSON.parse(raw);
      if (typeof question !== 'string' || question.trim().length < 2 || question.length > 6000) throw new Error('Enter a question between 2 and 6,000 characters.');
      const modeInstructions = {
        'step-by-step': 'Provide: 1) Knowledge Graph Node & Governing Equations, 2) Given Parameters in SI Units, 3) Step-by-Step Substitution & Calculation, 4) Dimensional & Order-of-Magnitude Verification, 5) Common Exam Trap & 1 Practice Follow-up Question.',
        'derivation': 'Provide: 1) Physical Principle & Control Volume / Free-Body Diagram Assumptions, 2) Differential/Algebraic Derivation from First Principles, 3) Boundary Conditions & Regime Limits, 4) Where the Formula Breaks Down.',
        'viva': 'Provide: 1) Concise Conceptual Explanation & Physical Intuition, 2) Real-World Mechanical Application, 3) 3 Viva-Voce / Technical Interview Questions with Model Answers.',
        'kg-synthesis': 'Synthesize two connected Knowledge Graph nodes to create a brand-new multi-step GATE/University worked numerical problem with 4 options, correct answer, and full solution.'
      }[mode || 'step-by-step'] || 'Explain step by step with governing formulas, units, and common traps.';

      const system = `You are MechPrep Arena's Elaborated Knowledge-Graph Engineering LLM Tutor. ${modeInstructions}\nGrounded Knowledge Graph Context:\n${String(kgContext || 'Standard Mechanical Engineering & General Aptitude Syllabus').slice(0, 3500)}`;
      const answer = await callLLM({
        system,
        prompt: `Study Area: ${String(topic || 'Mechanical Engineering').slice(0, 120)}\nReasoning Mode: ${mode || 'step-by-step'}\nStudent Prompt: ${question.trim()}`,
        apiKey,
        jsonMode: false
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer: answer || 'No text response was returned.' }));
    } catch (e) {
      const status = e.name === 'AbortError' || e.name === 'TimeoutError' ? 504 : (e.cause?.code === 'ECONNREFUSED' ? 503 : (e.message?.includes('API_KEY') ? 401 : 502));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Could not process request.' }));
    }
    return;
  }

  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, '0.0.0.0', () => console.log(`MechPrep Arena (Knowledge-Graph Edition) is ready at http://localhost:${port}`));
