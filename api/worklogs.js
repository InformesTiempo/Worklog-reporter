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

  const { action, project, dateFrom, dateTo, issueKey, groups } = req.query;

  try {
    // Load Jira groups
    if (action === 'groups') {
      const url = `${JIRA_URL}/rest/api/3/groups/picker?maxResults=50`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json({ groups: data.groups || [] });
    }

    // Look up user by username to get their accountId
    if (action === 'findUser') {
      const { username } = req.query;
      const url = `${JIRA_URL}/rest/api/3/user/search?query=${encodeURIComponent(username)}&maxResults=10`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      const users = Array.isArray(data) ? data : [];
      // Filter to find best match
      const match = users.find(u => 
        u.emailAddress?.toLowerCase().includes(username.toLowerCase()) ||
        u.displayName?.toLowerCase().includes(username.toLowerCase()) ||
        u.accountId === username
      );
      if(!match) return res.status(404).json({ error: `Usuario "${username}" no encontrado en Jira` });
      return res.status(200).json({ 
        accountId: match.accountId,
        displayName: match.displayName,
        emailAddress: match.emailAddress
      });
    }

    // Personal worklog view - get all worklogs for a specific user
    if (action === 'personal') {
      const { user, dateFrom, dateTo } = req.query;
      const jql = `worklogAuthor = "${user}" AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`;  // user is accountId
      let allWorklogs = [];
      let startAt = 0;

      while(true) {
        const url = `${JIRA_URL}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=100&fields=summary,worklog`;
        const r = await fetch(url, { headers });
        if(!r.ok) return res.status(r.status).json(await r.json());
        const data = await r.json();
        const issues = data.issues || [];

        for(const issue of issues) {
          let wls = issue.fields.worklog?.worklogs || [];
          if((issue.fields.worklog?.total || 0) > wls.length) {
            const wr = await fetch(`${JIRA_URL}/rest/api/3/issue/${issue.key}/worklog`, { headers });
            const wd = await wr.json();
            wls = wd.worklogs || [];
          }
          for(const wl of wls) {
            const wlDate = wl.started.split('T')[0];
            if(wlDate < dateFrom || wlDate > dateTo) continue;
            const authorEmail = wl.author?.emailAddress || '';
            const authorName = wl.author?.displayName || '';
            const authorId = wl.author?.accountId || '';
            if(authorId !== user) continue;
            allWorklogs.push({
              issueKey: issue.key,
              issueSummary: issue.fields.summary,
              started: wl.started,
              timeSpentSeconds: wl.timeSpentSeconds,
              author: wl.author
            });
          }
        }
        if((issues.length < 100) || data.isLast || !data.nextPageToken) break;
        startAt += 100;
      }

      return res.status(200).json({ worklogs: allWorklogs });
    }

    if (action === 'search') {
      const startAt = parseInt(req.query.startAt || '0');
      let jqlParts = [];

      // Project filter
      if (project) {
        const projects = project.split(',').map(p => p.trim()).filter(Boolean);
        if (projects.length === 1) jqlParts.push(`project = "${projects[0]}"`);
        else if (projects.length > 1) jqlParts.push(`project in (${projects.map(p=>`"${p}"`).join(', ')})`);
      }

      // Group/team filter — filter by worklog author belonging to group
      if (groups) {
        const groupList = groups.split(',').map(g => g.trim()).filter(Boolean);
        if (groupList.length === 1) {
          jqlParts.push(`worklogAuthor in membersOf("${groupList[0]}")`);
        } else if (groupList.length > 1) {
          const groupJql = groupList.map(g => `worklogAuthor in membersOf("${g}")`).join(' OR ');
          jqlParts.push(`(${groupJql})`);
        }
      }

      // Date filter
      jqlParts.push(`worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`);

      const jql = jqlParts.join(' AND ');
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
