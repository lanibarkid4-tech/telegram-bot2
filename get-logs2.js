const TOKEN = process.env.RAILWAY_TOKEN;
(async () => {
  const id = process.argv[2];
  const limit = parseInt(process.argv[3] || '30');
  const q = "query($id:String!,$limit:Int!){deploymentLogs(deploymentId:$id,limit:$limit){message timestamp severity}}";
  const r = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ query: q, variables: { id, limit } })
  });
  const j = await r.json();
  if (j.errors) { console.log("ERROR", JSON.stringify(j.errors)); return; }
  for (const l of j.data.deploymentLogs) console.log("[" + l.severity + "] " + l.message);
})();