const TOKEN = process.env.RAILWAY_TOKEN;
(async () => {
  console.log('Calling API...');
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      query: 'query ListDeploys($input: DeploymentListInput!) { deployments(input: $input) { edges { node { id status createdAt } } } }',
      variables: {
        input: {
          projectId: '38d5f8a1-9cf2-4181-905f-51ef23920c7e',
          serviceId: '41412063-f738-4798-9250-c436e7375f98',
          environmentId: '33bcc65c-d482-4b8d-aa31-4e1e07cb0ba9',
          first: 5
        }
      }
    })
  });
  const text = await r.text();
  console.log('HTTP', r.status);
  console.log('Body:', text);
})();