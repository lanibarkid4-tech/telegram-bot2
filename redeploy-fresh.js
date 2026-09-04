// Restart service fresh
const TOKEN = process.env.RAILWAY_TOKEN;
(async () => {
  // 1. Stop service instance
  const stopQ = `mutation($eid: String!, $sid: String!) {
    serviceInstanceStop(environmentId: $eid, serviceId: $sid)
  }`;
  await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      query: stopQ,
      variables: { eid: '33bcc65c-d482-4b8d-aa31-4e1e07cb0ba9', sid: '41412063-f738-4798-9250-c436e7375f98' }
    })
  });
  console.log('Stopped. Waiting 5s...');
  await new Promise(r => setTimeout(r, 5000));

  // 2. Redeploy
  const redeployQ = `mutation($eid: String!, $sid: String!) {
    serviceInstanceRedeploy(environmentId: $eid, serviceId: $sid)
  }`;
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      query: redeployQ,
      variables: { eid: '33bcc65c-d482-4b8d-aa31-4e1e07cb0ba9', sid: '41412063-f738-4798-9250-c436e7375f98' }
    })
  });
  console.log('Redeploy:', JSON.stringify(await r.json(), null, 2));
})();
