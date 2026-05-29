// Simple mock server for testing CLI — NOT for production use.
// This file exists exclusively for local development and integration tests.
// It intentionally returns fake data with no authentication.
if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: mock-server.js must not run in production.');
  process.exit(1);
}

const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

// Mock endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/projects', (req, res) => {
  res.json({
    org_id: `org_mock_${crypto.randomBytes(6).toString('hex')}`,
    project_id: `proj_mock_${crypto.randomBytes(6).toString('hex')}`,
    project_name: req.body.project_name,
    created: true
  });
});

app.get('/decrypt', (req, res) => {
  res.json({
    env_content: 'DATABASE_URL=mock://localhost:5432/db\nAPI_KEY=mock-placeholder',
    decrypt_key: crypto.randomBytes(32).toString('base64'),
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
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Capy service running on http://127.0.0.1:${PORT} (test only)`);
  console.log('\nSet environment variable:');
  console.log(`export CAPY_API_URL=http://127.0.0.1:${PORT}`);
});
