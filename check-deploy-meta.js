const TOKEN = process.env.RAILWAY_TOKEN;
(async () => {
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      query: 'query GetDeployment($id: String!) { deployment(id: $id) { id status createdAt meta } }',
      variables: { id: 'da956a76-fd71-4a51-a239-8a73d775e522' }
    })
  });
  console.log(JSON.stringify(await r.json(), null, 2));
})();