const modules = [
  'overview', 'sos', 'moderation', 'official', 'users', 'communities', 'media',
  'campaigns', 'translations', 'support', 'audit', 'analytics', 'platform',
];

async function main() {
  const baseUrl = 'https://yrrlankpwmhluexshxnw.supabase.co';
  const anonKey = 'sb_publishable_dQILq4zEe6xW1TpJPQwMHw_gk6ZlaX3';
  const bridge = await fetch(`${baseUrl}/functions/v1/quata-auth-bridge`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ country_code: '34', phone_local: '680242606', password: process.env.QOC_TEST_PASSWORD }),
  });
  const auth = await bridge.json();
  if (!bridge.ok || !auth.session?.access_token) throw new Error(`Bridge login failed: ${auth.error || bridge.status}`);
  const headers = { apikey: anonKey, Authorization: `Bearer ${auth.session.access_token}`, 'content-type': 'application/json' };
  const sessionResponse = await fetch(`${baseUrl}/rest/v1/rpc/qoc_session`, { method: 'POST', headers, body: '{}' });
  const session = await sessionResponse.json();
  if (!sessionResponse.ok || !session.profile?.isAdmin) throw new Error('QOC session was not authorized');
  const result = { user: session.profile.displayName, modules: {} };
  for (const module of modules) {
    const response = await fetch(`${baseUrl}/rest/v1/rpc/qoc_module_data`, { method: 'POST', headers, body: JSON.stringify({ p_module: module, p_limit: 10 }) });
    if (!response.ok) throw new Error(`Module ${module} failed with ${response.status}: ${await response.text()}`);
    const value = await response.json();
    result.modules[module] = Array.isArray(value) ? value.length : Object.keys(value || {}).length;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
