// Simple mock server for testing CLI
const express = require('express');
const app = express();
app.use(express.json());

// Mock endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/projects', (req, res) => {
  res.json({
    capy_id: 'org_mock123',
    project_id: 'proj_mock456',
    project_name: req.body.project_name,
    created: true
  });
});

app.get('/decrypt', (req, res) => {
  res.json({
    env_content: 'DATABASE_URL=postgres://localhost:5432/db\nAPI_KEY=sk-mock-key-123',
    decrypt_key: Buffer.from('mock-decrypt-key').toString('base64'),
    expires_at: new Date(Date.now() + 86400000).toISOString()
  });
});

app.post('/variables/push', (req, res) => {
  const result = {};
  for (const key of Object.keys(req.body.variables)) {
    result[key] = {
      resource_id: `res_${key}_${Date.now()}`,
      success: true
    };
  }
  res.json({ success: true, variables: result });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Mock CapyVault service running on http://localhost:${PORT}`);
  console.log('\nSet environment variable:');
  console.log(`export CAPY_API_URL=http://localhost:${PORT}`);
});