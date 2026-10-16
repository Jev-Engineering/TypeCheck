// Explicitly mounted by the isolated validation override; never copied into runtime.
import assert from 'node:assert/strict';
assert.equal(process.env.NODE_ENV, 'development');
assert.equal(process.env.API_ONLY, '1');
assert.equal(process.env.DISCORD_BOT_TOKEN, 'offline-fixture-only');
globalThis.fetch = async (url) => {
  assert.equal(String(url), 'https://discord.com/api/v10/users/@me', 'Offline harness forbids all other network requests');
  return Response.json({id: '100000000000000014'});
};
