// Update TELEGRAM_BOT_TOKEN di Railway
const TOKEN = process.env.RAILWAY_TOKEN;
const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

const PROJECT_ID = '38d5f8a1-9cf2-4181-905f-51ef23920c7e';
const SERVICE_ID = '41412063-f738-4798-9250-c436e7375f98';
const ENV_ID = '33bcc65c-d482-4b8d-aa31-4e1e07cb0ba9';

// Token baru dari .env
const NEW_TOKEN = '8803384308:AAEIh7nPjY2Gxz-7LTagKot9XihSLD0LJ3M';

async function gql(query, variables = {}) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) {
    console.error('ERROR:', JSON.stringify(j.errors, null, 2));
    return null;
  }
  return j.data;
}

(async () => {
  console.log('Setting TELEGRAM_BOT_TOKEN...');
  const data = await gql(
    `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
    { input: {
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      name: 'TELEGRAM_BOT_TOKEN',
      value: NEW_TOKEN
    }}
  );

  if (data && data.variableUpsert) {
    console.log('✅ Token updated successfully!');
    console.log('Redeploying to apply...');
  } else {
    console.log('❌ Failed to update token');
  }
})();
