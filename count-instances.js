// Cek berapa container/service instance yang aktif
const TOKEN = process.env.RAILWAY_TOKEN;
(async () => {
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      query: 'query GetService($id: String!) { service(id: $id) { id name serviceInstances { edges { node { id } } } } }',
      variables: { id: '41412063-f738-4798-9250-c436e7375f98' }
    })
  });
  const j = await r.json();
  console.log(JSON.stringify(j, null, 2));
})();