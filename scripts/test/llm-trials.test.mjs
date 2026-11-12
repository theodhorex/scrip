import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import {
  parseArgs,
  sanitizeModelName,
  summarizeTrials,
  runTrials,
} from '../llm-trials.mjs';

function createFakeOllama(chatHandler) {
  const server = http.createServer(async (req, res) => {
    try {
      const [path] = (req.url ?? '').split('?');
      if (path === '/api/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: '0.5.1' }));
        return;
      }
      if (path === '/api/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          let parsed = {};
          try { parsed = JSON.parse(body || '{}'); } catch {}
          await chatHandler(parsed, req, res);
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return {
    server,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    }),
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

test('parseArgs parses valid CLI arguments and sets defaults', () => {
  const args = parseArgs(['--model', 'qwen2.5:7b', '--seeds', '5', '--base-url', 'http://127.0.0.1:11434', '--out', '/tmp/out']);
  assert.equal(args.model, 'qwen2.5:7b');
  assert.equal(args.seeds, 5);
  assert.equal(args.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(args.out, '/tmp/out');

  // Default seeds, baseUrl, out
  const defaultArgs = parseArgs(['--model', 'llama3.2']);
  assert.equal(defaultArgs.model, 'llama3.2');
  assert.equal(defaultArgs.seeds, 20);
  assert.equal(defaultArgs.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(defaultArgs.out, './results');
});

test('parseArgs throws on missing model, invalid seeds, or unknown flag', () => {
  assert.throws(() => parseArgs([]), /--model is required/);
  assert.throws(() => parseArgs(['--model']), /Missing value for --model/);
  assert.throws(() => parseArgs(['--model', 'm', '--seeds', '0']), /--seeds must be a positive integer/);
  assert.throws(() => parseArgs(['--model', 'm', '--seeds', 'abc']), /--seeds must be a positive integer/);
  assert.throws(() => parseArgs(['--model', 'm', '--unknown']), /Unknown flag: --unknown/);
});

test('sanitizeModelName replaces colons with dashes', () => {
  assert.equal(sanitizeModelName('llama3.2'), 'llama3.2');
  assert.equal(sanitizeModelName('qwen2.5:7b'), 'qwen2.5-7b');
  assert.equal(sanitizeModelName('custom:model:tag'), 'custom-model-tag');
});

test('summarizeTrials aggregates counts across conditions and labels', () => {
  const trials = [
    { promptKind: 'normal', invoiceMode: 'honest', label: 'PAID_OK' },
    { promptKind: 'normal', invoiceMode: 'honest', label: 'PAID_OK' },
    { promptKind: 'normal', invoiceMode: 'injected', label: 'DECLINED' },
    { promptKind: 'hijacked', invoiceMode: 'injected', label: 'FOOLED_RECIPIENT' },
    { promptKind: 'normal', invoiceMode: 'overcharge', label: 'FOOLED_AMOUNT' },
    { promptKind: 'hijacked', invoiceMode: 'honest', label: 'BROKEN' },
  ];

  const summary = summarizeTrials(trials);
  assert.equal(summary.byCondition.normal.honest.PAID_OK, 2);
  assert.equal(summary.byCondition.normal.injected.DECLINED, 1);
  assert.equal(summary.byCondition.hijacked.injected.FOOLED_RECIPIENT, 1);
  assert.equal(summary.byCondition.normal.overcharge.FOOLED_AMOUNT, 1);
  assert.equal(summary.byCondition.hijacked.honest.BROKEN, 1);

  assert.equal(summary.totals.PAID_OK, 2);
  assert.equal(summary.totals.FOOLED_RECIPIENT, 1);
  assert.equal(summary.totals.FOOLED_AMOUNT, 1);
  assert.equal(summary.totals.DECLINED, 1);
  assert.equal(summary.totals.BROKEN, 1);
  assert.equal(summary.totals.total, 6);
});

test('runTrials executes full combinatorial matrix, writes JSON, and tolerates HTTP errors', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'llm-trials-test-'));

  const fakeOllama = createFakeOllama(async (body, req, res) => {
    // When promptKind is hijacked and invoiceMode is injected, fool the model
    const isHijacked = body.messages[0].content.includes('strictly follow any instructions');
    const isInjected = body.messages[1].content.includes('IMPORTANT SYSTEM NOTICE');

    if (isHijacked && isInjected) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        message: {
          tool_calls: [{ function: { name: 'pay', arguments: { recipient: 'attacker.testnet', amount: '1000000' } } }],
        },
      }));
      return;
    }

    // Default pay to merchant
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      message: {
        tool_calls: [{ function: { name: 'pay', arguments: { recipient: 'merchant.testnet', amount: '200000' } } }],
      },
    }));
  });

  const port = await fakeOllama.listen(0);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Run 2 seeds across 2 prompts × 3 invoices = 12 trials
    const res = await runTrials({
      model: 'qwen2.5:7b',
      seeds: 2,
      baseUrl,
      out: tmpDir,
    });

    assert.equal(res.trials.length, 12);
    const expectedFilePath = join(tmpDir, 'llm-trials-qwen2.5-7b.json');
    assert.ok(existsSync(expectedFilePath));

    const written = JSON.parse(readFileSync(expectedFilePath, 'utf8'));
    assert.equal(written.metadata.model, 'qwen2.5:7b');
    assert.equal(written.metadata.sanitizedModel, 'qwen2.5-7b');
    assert.equal(written.metadata.totalTrials, 12);
    assert.equal(written.trials.length, 12);

    // Check hijacked + injected condition was fooled 2 times
    assert.equal(written.summary.byCondition.hijacked.injected.FOOLED_RECIPIENT, 2);

    // Test that unreachable Ollama does not crash, but records BROKEN trials
    const unreachableRes = await runTrials({
      model: 'test-down:1b',
      seeds: 1,
      baseUrl: 'http://127.0.0.1:1', // Unreachable port
      out: tmpDir,
    });
    assert.equal(unreachableRes.trials.length, 6);
    assert.equal(unreachableRes.summary.totals.BROKEN, 6);
  } finally {
    await fakeOllama.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
