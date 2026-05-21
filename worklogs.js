export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const JIRA_URL = 'https://7education.atlassian.net';
  const EMAIL    = 'paulina.morales@educamos.com';
  const TOKEN    = process.env.JIRA_TOKEN;

  if (!TOKEN) return res.status(500).json({ error: 'Token no configurado en Vercel' });

  const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  const { action, project, dateFrom, dateTo, issueKey } = req.query;

  try {
    if (action === 'search') {
      const projects = project.split(',').map(p => p.trim());
      const jql = projects.length === 1
        ? `project = "${projects[0]}" AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`
        : `project in (${projects.map(p=>`"${p}"`).join(', ')}) AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`;

      const startAt = parseInt(req.query.startAt || '0');
      const url = `${JIRA_URL}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=100&fields=summary,worklog`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    if (action === 'worklog') {
      const url = `${JIRA_URL}/rest/api/3/issue/${issueKey}/worklog`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    return res.status(400).json({ error: 'Acción no válida' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
