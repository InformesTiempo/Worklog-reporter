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

  const { action, project, dateFrom, dateTo, issueKey, groups, user } = req.query;

  // Parse body for POST requests
  let parsedBody = {};
  if (req.method === 'POST' && req.body) {
    parsedBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }

  try {

    // ── Groups list ──────────────────────────────────────────
    if (action === 'groups') {
      const url = `${JIRA_URL}/rest/api/3/groups/picker?maxResults=50&query=Educamos`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(200).json({ groups: data.groups || [] });
    }

    // ── Personal view ────────────────────────────────────────
    if (action === 'personal') {
      const searchUrl = `${JIRA_URL}/rest/api/3/user/search?query=${encodeURIComponent(user)}&maxResults=10`;
      const searchR = await fetch(searchUrl, { headers });
      const users = await searchR.json();
      if (!Array.isArray(users) || users.length === 0) {
        return res.status(404).json({ error: `No se encontró el usuario "${user}" en Jira` });
      }
      const match = users[0];
      const accountId = match.accountId;

      // Search issues where this user logged work
      const jql = `worklogAuthor = "${accountId}" AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`;
      let allWorklogs = [];
      let startAt = 0;

      while (true) {
        const url = `${JIRA_URL}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=100&fields=summary,worklog`;
        const r = await fetch(url, { headers });
        if (!r.ok) return res.status(r.status).json(await r.json());
        const data = await r.json();
        const issues = data.issues || [];

        for (const issue of issues) {
          // Always fetch from dedicated endpoint with date filter to avoid duplicates
          let wlStart = 0;
          while(true) {
            const wr = await fetch(`${JIRA_URL}/rest/api/3/issue/${issue.key}/worklog?startAt=${wlStart}&maxResults=100`, { headers });
            if (!wr.ok) break;
            const wd = await wr.json();
            const wls = wd.worklogs || [];
            for (const wl of wls) {
              const wlDate = wl.started.split('T')[0];
              if (wlDate < dateFrom || wlDate > dateTo) continue;
              if (wl.author?.accountId !== accountId) continue;
              allWorklogs.push({
                issueKey: issue.key,
                issueSummary: issue.fields.summary,
                started: wl.started,
                timeSpentSeconds: wl.timeSpentSeconds,
                author: wl.author
              });
            }
            if (wls.length < 100 || wlStart + 100 >= (wd.total || 0)) break;
            wlStart += 100;
          }
        }
        if (issues.length < 100 || data.isLast || !data.nextPageToken) break;
        startAt += 100;
      }

      return res.status(200).json({ worklogs: allWorklogs, displayName: match.displayName });
    }

    // ── Search by person (manager view - NEW STRATEGY) ───────
    if (action === 'searchByPerson') {
      // Get members of selected groups
      const groupList = (groups || '').split(',').map(g => g.trim()).filter(Boolean);
      const projectList = (project || '').split(',').map(p => p.trim()).filter(Boolean);

      // Get all group members
      const allMembers = [];
      for (const group of groupList) {
        const gUrl = `${JIRA_URL}/rest/api/3/group/member?groupname=${encodeURIComponent(group)}&maxResults=500`;
        const gR = await fetch(gUrl, { headers });
        if (gR.ok) {
          const gData = await gR.json();
          (gData.values || []).forEach(u => {
            if (!allMembers.find(m => m.accountId === u.accountId)) {
              allMembers.push({ accountId: u.accountId, displayName: u.displayName });
            }
          });
        }
      }

      if (allMembers.length === 0) {
        return res.status(200).json({ personWorklogs: {} });
      }

      // For each person, get their worklogs directly
      const personWorklogs = {};

      for (const member of allMembers) {
        let jqlParts = [`worklogAuthor = "${member.accountId}"`, `worklogDate >= "${dateFrom}"`, `worklogDate <= "${dateTo}"`];
        if (projectList.length > 0) {
          jqlParts.push(projectList.length === 1 
            ? `project = "${projectList[0]}"` 
            : `project in (${projectList.map(p => `"${p}"`).join(',')})`);
        }
        const jql = jqlParts.join(' AND ');

        let issues = [];
        let startAt = 0;
        while (true) {
          const url = `${JIRA_URL}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=50&fields=summary,worklog`;
          const r = await fetch(url, { headers });
          if (!r.ok) break;
          const data = await r.json();
          issues = issues.concat(data.issues || []);
          if ((data.issues || []).length < 50 || data.isLast || !data.nextPageToken) break;
          startAt += 50;
        }

        let totalSecs = 0;
        const dailyMap = {};

        for (const issue of issues) {
          // Always fetch full worklog list from dedicated endpoint to avoid duplicates
          const wr = await fetch(`${JIRA_URL}/rest/api/3/issue/${issue.key}/worklog?maxResults=100`, { headers });
          if (!wr.ok) continue;
          const wd = await wr.json();
          const wls = wd.worklogs || [];
          
          for (const wl of wls) {
            if (wl.author?.accountId !== member.accountId) continue;
            const wlDate = wl.started.split('T')[0];
            if (wlDate < dateFrom || wlDate > dateTo) continue;
            const secs = wl.timeSpentSeconds || 0;
            totalSecs += secs;
            dailyMap[wlDate] = (dailyMap[wlDate] || 0) + secs;
          }
        }

        if (totalSecs > 0) {
          personWorklogs[member.displayName] = { totalSecs, dailyMap, accountId: member.accountId };
        }
      }

      return res.status(200).json({ personWorklogs, memberCount: allMembers.length });
    }

    // ── Single issue worklog ─────────────────────────────────
    if (action === 'worklog') {
      const url = `${JIRA_URL}/rest/api/3/issue/${issueKey}/worklog`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    // ── Log work (uses user's own token) ────────────────────
    if (action === 'logWork') {
      const { issueKey: wlIssueKey, timeSpentSeconds, date, comment, userEmail, userToken } = parsedBody;
      const issueKey = wlIssueKey;

      if (!userEmail || !userToken) {
        return res.status(400).json({ error: 'Credenciales no proporcionadas' });
      }

      // Use user's own credentials
      const userAuth = Buffer.from(`${userEmail}:${userToken}`).toString('base64');
      const userHeaders = {
        'Authorization': `Basic ${userAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      };

      const worklogBody = {
        timeSpentSeconds: parseInt(timeSpentSeconds),
        started: date + 'T09:00:00.000+0000'
      };

      if (comment) {
        worklogBody.comment = {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }]
        };
      }

      const url = `${JIRA_URL}/rest/api/3/issue/${issueKey}/worklog`;
      const r = await fetch(url, {
        method: 'POST',
        headers: userHeaders,
        body: JSON.stringify(worklogBody)
      });

      const data = await r.json();
      if (!r.ok) {
        return res.status(r.status).json({ 
          error: data.errorMessages?.[0] || data.message || `Error ${r.status}` 
        });
      }
      return res.status(200).json({ success: true, id: data.id });
    }

    // ── Find issue by key or text ────────────────────────────
    if (action === 'findIssue') {
      const q = req.query.q || '';
      const isKey = /^[A-Z]+-\d+$/i.test(q.trim());
      if (isKey) {
        const url = `${JIRA_URL}/rest/api/3/issue/${q.toUpperCase()}?fields=summary`;
        const r = await fetch(url, { headers });
        if (!r.ok) return res.status(404).json({ error: 'Issue no encontrado' });
        const d = await r.json();
        return res.status(200).json({ key: d.key, summary: d.fields.summary });
      } else {
        const jql = encodeURIComponent(`summary ~ "${q}" ORDER BY updated DESC`);
        const url = `${JIRA_URL}/rest/api/3/search/jql?jql=${jql}&maxResults=5&fields=summary`;
        const r = await fetch(url, { headers });
        if (!r.ok) return res.status(404).json({ error: 'Error en la búsqueda' });
        const d = await r.json();
        if (!d.issues?.length) return res.status(404).json({ error: 'No se encontraron issues' });
        return res.status(200).json({ key: d.issues[0].key, summary: d.issues[0].fields.summary });
      }
    }

    return res.status(400).json({ error: 'Acción no válida' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
