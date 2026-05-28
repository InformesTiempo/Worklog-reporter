// api/worklogs.js — Vercel Serverless Function (CommonJS)
// Acciones: saveCredentials, login, personal, findIssue, logWork, searchByPerson

const https = require('https');

// ── Upstash Redis helpers ──────────────────────────────────────────────────
function upstashUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
}
function upstashToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
}

async function kvGet(key) {
  const res = await fetch(`${upstashUrl()}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${upstashToken()}` }
  });
  const j = await res.json();
  return j.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  await fetch(`${upstashUrl()}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${upstashToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
}

// ── Jira helpers ──────────────────────────────────────────────────────────
const JIRA_BASE = 'https://7education.atlassian.net';

async function jiraFetch(path, email, token, options = {}) {
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const url = `${JIRA_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  return res;
}

// ── Acciones ──────────────────────────────────────────────────────────────

// POST ?action=saveCredentials  { email, token, pin }
async function saveCredentials(body) {
  const { email, token, pin } = body;
  if (!email || !token || !pin) return { error: 'Faltan campos' };
  if (!/^\d{4}$/.test(pin)) return { error: 'PIN debe ser 4 dígitos' };

  // Verificar que el token es válido contra Jira antes de guardar
  const test = await jiraFetch('/rest/api/2/myself', email, token);
  if (!test.ok) return { error: 'Token o email incorrecto en Jira' };

  const key = `wl:${email.toLowerCase()}`;
  await kvSet(key, { email, token, pin });
  return { ok: true };
}

// POST ?action=login  { email, pin }
async function login(body) {
  const { email, pin } = body;
  if (!email || !pin) return { error: 'Faltan campos' };

  const key = `wl:${email.toLowerCase()}`;
  const record = await kvGet(key);
  if (!record) return { error: 'Usuario no registrado' };
  if (record.pin !== pin) return { error: 'PIN incorrecto' };

  return { ok: true, token: record.token, email: record.email };
}

// GET ?action=personal&user=email&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
async function getPersonalWorklogs(query, authEmail, authToken) {
  const { user, dateFrom, dateTo } = query;

  // Buscar issues con worklogs en el periodo
  const jql = encodeURIComponent(
    `worklogAuthor = "${user}" AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}" ORDER BY updated DESC`
  );
  const searchRes = await jiraFetch(
    `/rest/api/2/search?jql=${jql}&fields=summary,worklog,issuetype,priority&maxResults=100`,
    authEmail, authToken
  );
  if (!searchRes.ok) {
    const e = await searchRes.json();
    return { error: e.errorMessages?.[0] || `Error ${searchRes.status}` };
  }
  const searchData = await searchRes.json();

  const worklogs = [];
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  to.setHours(23, 59, 59);

  for (const issue of searchData.issues || []) {
    // Si hay más de 20 worklogs en el issue, hay que paginar
    let issueWorklogs = issue.fields.worklog?.worklogs || [];
    if ((issue.fields.worklog?.total || 0) > 20) {
      const wRes = await jiraFetch(`/rest/api/2/issue/${issue.key}/worklog`, authEmail, authToken);
      if (wRes.ok) {
        const wData = await wRes.json();
        issueWorklogs = wData.worklogs || [];
      }
    }

    for (const wl of issueWorklogs) {
      if (!wl.author?.emailAddress?.toLowerCase().includes(user.toLowerCase()) &&
          !wl.author?.name?.toLowerCase().includes(user.toLowerCase()) &&
          wl.author?.emailAddress?.toLowerCase() !== user.toLowerCase()) continue;

      const started = new Date(wl.started);
      if (started < from || started > to) continue;

      worklogs.push({
        issueKey: issue.key,
        issueSummary: issue.fields.summary,
        issueType: issue.fields.issuetype?.name,
        timeSpentSeconds: wl.timeSpentSeconds,
        timeSpent: wl.timeSpent,
        started: wl.started,
        comment: wl.comment || ''
      });
    }
  }

  const totalSeconds = worklogs.reduce((s, w) => s + w.timeSpentSeconds, 0);
  return { worklogs, totalSeconds };
}

// GET ?action=findIssue&q=TEXT
async function findIssue(query, authEmail, authToken) {
  const { q } = query;
  if (!q) return { issues: [] };

  const isKey = /^[A-Z]+-\d+$/.test(q.trim().toUpperCase());
  let jql;
  if (isKey) {
    jql = `key = "${q.trim().toUpperCase()}"`;
  } else {
    jql = `summary ~ "${q}" ORDER BY updated DESC`;
  }

  const res = await jiraFetch(
    `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,issuetype,status&maxResults=10`,
    authEmail, authToken
  );
  if (!res.ok) return { issues: [] };
  const data = await res.json();

  return {
    issues: (data.issues || []).map(i => ({
      key: i.key,
      summary: i.fields.summary,
      type: i.fields.issuetype?.name,
      status: i.fields.status?.name
    }))
  };
}

// POST ?action=logWork  { issueKey, timeSpentSeconds, date, comment, userEmail, userToken }
async function logWork(body) {
  const { issueKey, timeSpentSeconds, date, comment, userEmail, userToken } = body;
  if (!issueKey || !timeSpentSeconds || !date || !userEmail || !userToken) {
    return { error: 'Faltan campos obligatorios' };
  }

  const started = `${date}T09:00:00.000+0000`;
  const payload = { timeSpentSeconds, started };
  if (comment) payload.comment = comment;

  const res = await jiraFetch(
    `/rest/api/2/issue/${issueKey}/worklog`,
    userEmail, userToken,
    { method: 'POST', body: JSON.stringify(payload) }
  );

  if (!res.ok) {
    const e = await res.json();
    return { error: e.errorMessages?.[0] || `Error ${res.status}` };
  }
  const data = await res.json();
  return { ok: true, id: data.id };
}

// GET ?action=searchByPerson&groups=G1,G2&dateFrom=...&dateTo=...&project=P1,P2
async function searchByPerson(query, authEmail, authToken) {
  const { groups, dateFrom, dateTo, project } = query;
  if (!groups) return { error: 'Falta groups' };

  const groupList = groups.split(',').map(g => g.trim()).filter(Boolean);

  // Obtener miembros de cada grupo
  const members = new Map();
  for (const group of groupList) {
    const res = await jiraFetch(
      `/rest/api/2/group/member?groupname=${encodeURIComponent(group)}&maxResults=50`,
      authEmail, authToken
    );
    if (!res.ok) continue;
    const data = await res.json();
    for (const u of data.values || []) {
      members.set(u.emailAddress || u.name, u.displayName || u.emailAddress || u.name);
    }
  }

  if (members.size === 0) return { personWorklogs: {} };

  // Para cada miembro obtener worklogs
  const personWorklogs = {};

  for (const [userEmail, displayName] of members) {
    let jql = `worklogAuthor = "${userEmail}" AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`;
    if (project) {
      const projs = project.split(',').map(p => `"${p.trim()}"`).join(',');
      jql += ` AND project in (${projs})`;
    }
    jql += ' ORDER BY updated DESC';

    const searchRes = await jiraFetch(
      `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,worklog&maxResults=100`,
      authEmail, authToken
    );
    if (!searchRes.ok) continue;
    const searchData = await searchRes.json();

    let totalSecs = 0;
    const dailyMap = {};

    for (const issue of searchData.issues || []) {
      let wls = issue.fields.worklog?.worklogs || [];
      if ((issue.fields.worklog?.total || 0) > 20) {
        const wRes = await jiraFetch(`/rest/api/2/issue/${issue.key}/worklog`, authEmail, authToken);
        if (wRes.ok) { const wd = await wRes.json(); wls = wd.worklogs || []; }
      }

      const from = new Date(dateFrom);
      const to = new Date(dateTo); to.setHours(23, 59, 59);

      for (const wl of wls) {
        const authorId = wl.author?.emailAddress || wl.author?.name || '';
        if (!authorId.toLowerCase().includes(userEmail.toLowerCase()) &&
            authorId.toLowerCase() !== userEmail.toLowerCase()) continue;

        const started = new Date(wl.started);
        if (started < from || started > to) continue;

        totalSecs += wl.timeSpentSeconds;
        const day = wl.started.substring(0, 10);
        dailyMap[day] = (dailyMap[day] || 0) + wl.timeSpentSeconds;
      }
    }

    personWorklogs[displayName] = { totalSecs, dailyMap, email: userEmail };
  }

  return { personWorklogs };
}

// ── Handler principal ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    // Acciones POST que no necesitan auth de Jira directa
    if (req.method === 'POST') {
      const body = req.body || {};

      if (action === 'saveCredentials') {
        const result = await saveCredentials(body);
        return res.status(result.error ? 400 : 200).json(result);
      }

      if (action === 'login') {
        const result = await login(body);
        return res.status(result.error ? 401 : 200).json(result);
      }

      if (action === 'logWork') {
        const result = await logWork(body);
        return res.status(result.error ? 400 : 200).json(result);
      }

      return res.status(400).json({ error: 'Acción POST desconocida' });
    }

    // Acciones GET — necesitan credenciales de Jira
    // Obtenerlas desde Upstash usando el email del query o de la sesión
    const userParam = req.query.user || req.query.userEmail;
    if (!userParam) return res.status(401).json({ error: 'Falta parámetro user' });

    const record = await kvGet(`wl:${userParam.toLowerCase()}`);
    if (!record) return res.status(401).json({ error: 'Usuario no autenticado' });

    const { email: authEmail, token: authToken } = record;

    if (action === 'personal') {
      const result = await getPersonalWorklogs(req.query, authEmail, authToken);
      return res.status(result.error ? 400 : 200).json(result);
    }

    if (action === 'findIssue') {
      const result = await findIssue(req.query, authEmail, authToken);
      return res.status(200).json(result);
    }

    if (action === 'searchByPerson') {
      const result = await searchByPerson(req.query, authEmail, authToken);
      return res.status(result.error ? 400 : 200).json(result);
    }

    return res.status(400).json({ error: 'Acción desconocida' });

  } catch (err) {
    console.error('worklogs handler error:', err);
    return res.status(500).json({ error: err.message || 'Error interno' });
  }
};
