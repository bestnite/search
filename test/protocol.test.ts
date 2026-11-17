import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol, render } from '../src/protocol.js';
import type { ToolDefinition } from '../src/tools.js';

const echoTool: ToolDefinition = {
  name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  async call(args) { return { text: String(args.value ?? '') }; },
};
const brokenTool: ToolDefinition = { name: 'broken', description: 'Always fails', inputSchema: { type: 'object', properties: {} }, async call() { throw new Error('backend said no'); } };

function harness() {
  const out: string[] = [];
  const protocol = createProtocol([echoTool, brokenTool], { name: 'websearch-mcp', version: '9.9.9' }, { write: chunk => { out.push(chunk); return true; } });
  const send = async (message: unknown) => { await protocol.handle(JSON.stringify(message), new AbortController().signal); return JSON.parse(out.pop()!.trim()); };
  return { send };
}

test('initialize negotiates the protocol and advertises tools', async () => {
  const { send } = harness();
  const reply = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  assert.equal(reply.result.serverInfo.name, 'websearch-mcp');
  assert.equal(reply.result.serverInfo.version, '9.9.9');
  assert.ok(reply.result.capabilities.tools);
});

test('an unsupported protocol version falls back to the server default', async () => {
  const { send } = harness();
  const reply = await send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(reply.result.protocolVersion, '2025-06-18');
});

test('tools/list exposes schemas and tools/call returns text plus structured content', async () => {
  const { send } = harness();
  const list = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ['echo', 'broken']);
  const called = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } });
  assert.equal(called.result.content[0].text, 'hi');
  assert.equal(called.result.isError, false);
  assert.deepEqual(called.result.structuredContent, { text: 'hi' });
});

test('a tool that throws reports isError with its message, not a protocol failure', async () => {
  const { send } = harness();
  const reply = await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'broken', arguments: {} } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /backend said no/);
});

test('unknown tools and methods answer with JSON-RPC errors', async () => {
  const { send } = harness();
  const unknownTool = await send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknownTool.error.code, -32602);
  assert.deepEqual(unknownTool.error.data.available, ['echo', 'broken']);
  const unknownMethod = await send({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(unknownMethod.error.code, -32601);
});

test('malformed input is reported without killing the stream', async () => {
  const out: string[] = [];
  const protocol = createProtocol([echoTool], { name: 'websearch-mcp', version: '0' }, { write: chunk => { out.push(chunk); return true; } });
  await protocol.handle('{not json', new AbortController().signal);
  assert.equal(JSON.parse(out.pop()!.trim()).error.code, -32700);
  await protocol.handle(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }), new AbortController().signal);
  assert.deepEqual(JSON.parse(out.pop()!.trim()).result, {});
});

test('rendering prefers post text, then a source list, then JSON', () => {
  assert.equal(render({ text: 'a thread' }), 'a thread');
  assert.match(render({ report: 'one failed', sources: [{ title: 'T', url: 'https://e.test' }] }), /one failed[\s\S]*- T <https:\/\/e.test>/);
  assert.match(render({ other: 1 }), /"other": 1/);
});
