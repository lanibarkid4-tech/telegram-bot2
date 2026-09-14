require('dotenv').config();
const { execSync } = require('child_process');

const DEPLOY_ENABLED = process.env.RAILWAY_DEPLOY_ENABLED === 'true' || process.env.AUTO_DEPLOY === 'true';

if (!DEPLOY_ENABLED) {
  console.log('ℹ️ Auto redeploy disabled for this runtime. Set RAILWAY_DEPLOY_ENABLED=true to allow a manual redeploy from a local machine with Railway CLI installed.');
  process.exit(0);
}

function detectRailwayCliState() {
  try {
    const out = execSync('railway status --json', {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });

    const parsed = JSON.parse(out);
    const envNode = parsed?.environments?.edges?.[0]?.node;
    const serviceNode = envNode?.serviceInstances?.edges?.[0]?.node;

    return {
      projectId: parsed?.id || null,
      projectName: parsed?.name || null,
      environmentId: envNode?.id || null,
      environmentName: envNode?.name || null,
      serviceId: serviceNode?.serviceId || null,
      serviceName: serviceNode?.serviceName || null
    };
  } catch {
    return {};
  }
}

function runCliDeploy() {
  const cliState = detectRailwayCliState();
  const serviceName = process.env.RAILWAY_SERVICE_NAME || cliState.serviceName || 'bot-forex-hp';
  const environmentName = process.env.RAILWAY_ENVIRONMENT || cliState.environmentName || 'production';
  const projectId = process.env.RAILWAY_PROJECT_ID || cliState.projectId || null;

  const args = ['up', '--detach', '--service', serviceName, '--environment', environmentName];
  if (projectId) args.push('--project', projectId);

  console.log('Using Railway CLI deploy:');
  console.log('Command:', ['railway', ...args].join(' '));
  execSync(`railway ${args.map((a) => JSON.stringify(a)).join(' ')}`, { stdio: 'inherit' });
}

(async () => {
  try {
    runCliDeploy();
  } catch (err) {
    const token = process.env.RAILWAY_TOKEN;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || '33bcc65c-d482-4b8d-aa31-4e1e07cb0ba9';
    const serviceId = process.env.RAILWAY_SERVICE_ID || '41412063-f738-4798-9250-c436e7375f98';

    if (!token || !environmentId || !serviceId) {
      console.error('❌ Redeploy gagal. Railway CLI tidak terhubung dan token/ID belum tersedia.');
      process.exit(1);
    }

    console.error('⚠️ Railway CLI tidak tersedia, fallback ke GraphQL token manual.');
    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        query: `mutation($eid: String!, $sid: String!) { serviceInstanceRedeploy(environmentId: $eid, serviceId: $sid) }`,
        variables: { eid: environmentId, sid: serviceId }
      })
    });

    const body = await res.json();
    if (!res.ok || (body && Array.isArray(body.errors) && body.errors.length)) {
      console.error(JSON.stringify(body, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify(body, null, 2));
  }
})();
