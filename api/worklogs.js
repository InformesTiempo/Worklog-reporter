// api/worklogs.js — Vercel Serverless Function (CommonJS)
// Jira Cloud: 7education.atlassian.net

const JIRA_BASE = 'https://7education.atlassian.net';

// ── Upstash Redis (solo para saveCredentials y login) ─────────────────────
function upstashUrl()   { return process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL; }
function upstashToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }

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

// ── Jira helper (Basic Auth con email:token) ──────────────────────────────
async function jiraFetch(path, email, token, options = {}) {
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const res = await fetch(`${JIRA_BASE}${path}`, {
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

// ── saveCredentials: guarda email+token en Upstash ────────────────────────
async function saveCredentials(body) {
  const { email, token, pin } = body;
  if (!email || !token) return { error: 'Faltan campos' };

  // Verificar token válido en Jira antes de guardar
  const test = await jiraFetch('/rest/api/3/myself', email, token);
  if (!test.ok) return { error: 'Token o email incorrecto en Jira' };

  const key = `wl:${email.toLowerCase()}`;
  await kvSet(key, { email, token, pin: pin || '' });
  return { ok: true };
}

// ── login: recupera token de Upstash ─────────────────────────────────────
async function login(body) {
  const { email, pin } = body;
  if (!email) return { error: 'Falta email' };

  const key = `wl:${email.toLowerCase()}`;
  const record = await kvGet(key);
  if (!record) return { error: 'Usuario no registrado. Usa "Regístrate aquí" la primera vez.' };
  if (record.pin && pin && record.pin !== pin) return { error: 'PIN incorrecto' };

  return { ok: true, token: record.token, email: record.email };
}

// ── findIssue: usa el token que manda el frontend directamente ────────────
// El frontend manda: ?action=findIssue&q=...&userEmail=...&userToken=...
// O alternativamente busca en Upstash si solo manda userEmail
async function findIssue(query) {
  const { q, userEmail, userToken } = query;
  if (!q || !userEmail) return { error: 'Faltan parámetros' };

  let token = userToken;
  if (!token) {
    // fallback: buscar en Upstash
    const record = await kvGet(`wl:${userEmail.toLowerCase()}`);
    if (!record) return { error: 'No autenticado' };
    token = record.token;
  }

  const isKey = /^[A-Z]+-\d+$/i.test(q.trim());
  let jql = isKey
    ? `key = "${q.trim().toUpperCase()}"`
    : `summary ~ "${q}" ORDER BY updated DESC`;

  const res = await jiraFetch(
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,issuetype,status&maxResults=5`,
    userEmail, token
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    return { error: e.errorMessages?.[0] || `Error ${res.status}` };
  }
  const data = await res.json();
  const first = (data.issues || [])[0];
  if (!first) return { error: 'Issue no encontrado' };

  // Devuelve key+summary directamente (lo que espera el frontend)
  return {
    key: first.key,
    summary: first.fields.summary,
    type: first.fields.issuetype?.name,
    status: first.fields.status?.name
  };
}

// ── logWork: usa el token del usuario directamente (del frontend) ─────────
async function logWork(body) {
  const { issueKey, timeSpentSeconds, date, comment, userEmail, userToken } = body;
  if (!issueKey || !timeSpentSeconds || !date || !userEmail || !userToken) {
    return { error: 'Faltan campos obligatorios' };
  }

  const now = new Date();
  const started = `${date}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00.000+0000`;
  const payload = { timeSpentSeconds, started };
  if (comment) payload.comment = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] };

  const res = await jiraFetch(
    `/rest/api/3/issue/${issueKey}/worklog`,
    userEmail, userToken,
    { method: 'POST', body: JSON.stringify(payload) }
  );

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    return { error: e.errorMessages?.[0] || `Error ${res.status}` };
  }
  const data = await res.json();
  return { ok: true, id: data.id };
}

// ── personal: worklogs del usuario en un rango de fechas ─────────────────
async function getPersonalWorklogs(query) {
  const { user, dateFrom, dateTo, userToken } = query;
  if (!user) return { error: 'Falta user' };

  // Usar token del query si viene, si no buscarlo en Upstash
  let email = user;
  let token = userToken;
  if (!token) {
    const record = await kvGet(`wl:${user.toLowerCase()}`);
    if (!record) return { error: 'No autenticado' };
    email = record.email;
    token = record.token;
  }

  // Jira Cloud requiere accountId en el JQL, no email
  const myselfRes = await jiraFetch('/rest/api/3/myself', email, token);
  if (!myselfRes.ok) return { error: 'No se pudo obtener el perfil de Jira' };
  const myself = await myselfRes.json();
  const accountId = myself.accountId;

  const jql = `worklogAuthor = "${accountId}" AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}" ORDER BY updated DESC`;
  const searchRes = await jiraFetch(
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,worklog,issuetype&maxResults=100`,
    email, token
  );
  if (!searchRes.ok) {
    const e = await searchRes.json().catch(() => ({}));
    return { error: e.errorMessages?.[0] || `Error ${searchRes.status}` };
  }
  const searchData = await searchRes.json();

  const worklogs = [];
  const from = new Date(dateFrom);
  const to = new Date(dateTo); to.setHours(23, 59, 59);

  for (const issue of searchData.issues || []) {
    let wls = issue.fields.worklog?.worklogs || [];
    if ((issue.fields.worklog?.total || 0) > 20) {
      const wRes = await jiraFetch(`/rest/api/3/issue/${issue.key}/worklog`, email, token);
      if (wRes.ok) { const wd = await wRes.json(); wls = wd.worklogs || []; }
    }
    for (const wl of wls) {
      // Filtrar por accountId
      const wlAccountId = wl.author?.accountId || '';
      if (wlAccountId !== accountId) continue;
      const started = new Date(wl.started);
      if (started < from || started > to) continue;
      worklogs.push({
        issueKey: issue.key,
        issueSummary: issue.fields.summary,
        timeSpentSeconds: wl.timeSpentSeconds,
        timeSpent: wl.timeSpent,
        started: wl.started,
        comment: wl.comment?.content?.[0]?.content?.[0]?.text || ''
      });
    }
  }

  return { worklogs, totalSeconds: worklogs.reduce((s, w) => s + w.timeSpentSeconds, 0) };
}

// ── searchByPerson: worklogs por grupos ───────────────────────────────────
async function searchByPerson(query) {
  const { groups, dateFrom, dateTo, project, user, userToken } = query;
  if (!groups || !user) return { error: 'Faltan grupos o user' };

  let authEmail = user;
  let authToken = userToken;
  if (!authToken) {
    const record = await kvGet(`wl:${user.toLowerCase()}`);
    if (!record) return { error: 'No autenticado' };
    authEmail = record.email;
    authToken = record.token;
  }

  const groupList = groups.split(',').map(g => g.trim()).filter(Boolean);
  const members = new Map();

  for (const group of groupList) {
    const res = await jiraFetch(
      `/rest/api/3/group/member?groupname=${encodeURIComponent(group)}&maxResults=50`,
      authEmail, authToken
    );
    if (!res.ok) continue;
    const data = await res.json();
    for (const u of data.values || []) {
      // Guardar accountId para usarlo en JQL (Jira Cloud no acepta email)
      members.set(u.accountId, { displayName: u.displayName || u.emailAddress, email: u.emailAddress });
    }
  }

  if (members.size === 0) return { personWorklogs: {} };

  const personWorklogs = {};
  for (const [accountId, memberInfo] of members) {
    const { displayName, email: memberEmail } = memberInfo;
    let jql = `worklogAuthor = "${accountId}" AND worklogDate >= "${dateFrom}" AND worklogDate <= "${dateTo}"`;
    if (project) {
      const projs = project.split(',').map(p => `"${p.trim()}"`).join(',');
      jql += ` AND project in (${projs})`;
    }
    const searchRes = await jiraFetch(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,worklog&maxResults=100`,
      authEmail, authToken
    );
    if (!searchRes.ok) continue;
    const searchData = await searchRes.json();

    let totalSecs = 0;
    const dailyMap = {};
    const from = new Date(dateFrom), to = new Date(dateTo); to.setHours(23, 59, 59);

    for (const issue of searchData.issues || []) {
      let wls = issue.fields.worklog?.worklogs || [];
      if ((issue.fields.worklog?.total || 0) > 20) {
        const wRes = await jiraFetch(`/rest/api/3/issue/${issue.key}/worklog`, authEmail, authToken);
        if (wRes.ok) { const wd = await wRes.json(); wls = wd.worklogs || []; }
      }
      for (const wl of wls) {
        if ((wl.author?.accountId || '') !== accountId) continue;
        const started = new Date(wl.started);
        if (started < from || started > to) continue;
        totalSecs += wl.timeSpentSeconds;
        const day = wl.started.substring(0, 10);
        dailyMap[day] = (dailyMap[day] || 0) + wl.timeSpentSeconds;
      }
    }
    personWorklogs[displayName] = { totalSecs, dailyMap, email: memberEmail || accountId };
  }

  return { personWorklogs };
}

// ── Handler principal ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    if (req.method === 'POST') {
      const body = req.body || {};

      if (action === 'saveCredentials') {
        const r = await saveCredentials(body);
        return res.status(r.error ? 400 : 200).json(r);
      }
      if (action === 'login') {
        const r = await login(body);
        return res.status(r.error ? 401 : 200).json(r);
      }
      if (action === 'logWork') {
        const r = await logWork(body);
        return res.status(r.error ? 400 : 200).json(r);
      }
      return res.status(400).json({ error: 'Acción POST desconocida' });
    }

    // GET actions
    if (action === 'findIssue') {
      const r = await findIssue(req.query);
      return res.status(r.error ? 400 : 200).json(r);
    }
    if (action === 'personal') {
      const r = await getPersonalWorklogs(req.query);
      return res.status(r.error ? 400 : 200).json(r);
    }
    if (action === 'searchByPerson') {
      const r = await searchByPerson(req.query);
      return res.status(r.error ? 400 : 200).json(r);
    }

    return res.status(400).json({ error: 'Acción desconocida' });

  } catch (err) {
    console.error('worklogs error:', err);
    return res.status(500).json({ error: err.message || 'Error interno' });
  }
};
