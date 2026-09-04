const TOKEN = process.env.RAILWAY_TOKEN;
(async () => {
  const q = `query($pid:String!) {
    project(id: $pid) {
      id name
      services {
        edges {
          node {
            id name
            serviceInstances {
              edges { node { id latestDeployment { id status createdAt } } }
            }
          }
        }
      }
    }
  }`;
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({
      query: q,
      variables: { pid: '38d5f8a1-9cf2-4181-905f-51ef23920c7e' }
    })
  });
  const j = await r.json();
  console.log(JSON.stringify(j, null, 2));
})();
