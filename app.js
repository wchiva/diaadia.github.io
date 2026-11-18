/* FlowTask — front-end multiusuário (Supabase Auth + Postgres + Realtime)
 *
 * Segurança:
 *  - Nenhum dado de usuário entra no DOM via innerHTML (helper h() usa textContent / nós de texto).
 *  - As permissões aqui só refletem a interface; quem MANDA é o banco (RLS + triggers em supabase/schema.sql).
 *  - Só a chave pública (anon) existe no navegador. A service_role vive apenas na Edge Function.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constantes
  const STATUS = { todo: 'Pendente', in_progress: 'Em andamento', done: 'Concluída' };
  const STATUS_ORDER = ['todo', 'in_progress', 'done'];
  const PRIORITY = {
    high:   { label: 'Alta',  rank: 3, badge: 'bg-red-500/15 text-red-400 border-red-500/30',             bar: 'border-l-red-500',     dot: 'bg-red-500' },
    medium: { label: 'Média', rank: 2, badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',       bar: 'border-l-amber-400',   dot: 'bg-amber-400' },
    low:    { label: 'Baixa', rank: 1, badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', bar: 'border-l-emerald-500', dot: 'bg-emerald-500' },
  };
  const ROLE_LABEL = { admin: 'Administrador', member: 'Membro' };
  const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MIN_PASSWORD = 8;

  const S = {
    sb: null, me: null, profiles: [], pmap: new Map(), tasks: [],
    channel: null, pollTimer: null, rtOk: false,
    tab: 'kanban', calYear: new Date().getFullYear(), calMonth: new Date().getMonth(),
    bootedUid: null, forceNewPass: false, authChain: Promise.resolve(), lastLoad: 0, pendingNotice: null,
  };

  // ------------------------------------------------------------------ utilitários
  const $ = (id) => document.getElementById(id);

  /** Cria elemento sem jamais interpretar HTML (strings viram texto). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function show(el, flexClasses) {
    el.hidden = false;
    if (flexClasses) el.classList.add(...flexClasses.split(' '));
  }
  function hide(el) { el.hidden = true; }

  function showScreen(name) {
    const map = { loading: 'screen-loading', config: 'screen-config', auth: 'screen-auth', app: 'screen-app' };
    for (const [k, id] of Object.entries(map)) {
      const el = $(id);
      if (k === name) show(el, k === 'app' ? 'flex' : (k === 'loading' ? '' : 'flex'));
      else { hide(el); el.classList.remove('flex'); }
    }
  }

  function toast(msg, kind) {
    const cls = kind === 'error' ? 'bg-red-950 border-red-500/40 text-red-200'
      : kind === 'success' ? 'bg-emerald-950 border-emerald-500/40 text-emerald-200'
      : 'bg-[#1e1e1e] border-[#2a2a2a] text-zinc-200';
    const el = h('div', { class: `pointer-events-auto text-sm rounded-lg border px-4 py-2.5 shadow-lg ${cls}`, role: kind === 'error' ? 'alert' : 'status', text: msg });
    $('toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
  }

  function friendlyError(err) {
    if (!err) return 'Não foi possível concluir a operação.';
    const msg = String(err.message || err);
    const code = err.code || '';
    console.error('[FlowTask]', err);
    if (/Invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(msg)) return 'Este e-mail ainda não foi confirmado.';
    if (/banned/i.test(msg)) return 'Sua conta está desativada. Procure um administrador.';
    if (/rate limit|too many/i.test(msg) || err.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
    if (/New password should be different/i.test(msg)) return 'A nova senha precisa ser diferente da anterior.';
    if (/Password should be at least|weak/i.test(msg)) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão com o servidor. Verifique sua internet.';
    if (/JWT expired|invalid JWT/i.test(msg)) return 'Sua sessão expirou. Entre novamente.';
    if (code === '42501' && !/row-level security|permission denied/i.test(msg)) return msg; // mensagens em português dos triggers
    if (code === 'P0001' && /administrador/i.test(msg)) return msg;
    if (code === '42501' || code === 'PGRST116' || /row-level security|permission denied/i.test(msg)) return 'Você não tem permissão para esta ação.';
    if (code === '23514') return 'Dados inválidos. Revise título (até 200 caracteres), descrição (até 2000), prioridade e status.';
    return 'Não foi possível concluir a operação. Tente novamente.';
  }

  const pad = (n) => String(n).padStart(2, '0');
  function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtDate(s) { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; }
  function fmtDateTime(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }

  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }

  const isAdmin = () => !!S.me && S.me.role === 'admin';
  const canEdit = (t) => isAdmin() || t.created_by === S.me.id || t.assignee_id === S.me.id;
  const canChangePriority = (t) => isAdmin() || t.created_by === S.me.id;
  const profileName = (id) => (id && S.pmap.get(id) ? (S.pmap.get(id).full_name || S.pmap.get(id).email) : null);

  function rebuildProfileMap() { S.pmap = new Map(S.profiles.map((p) => [p.id, p])); }

  // ------------------------------------------------------------------ autenticação
  function showAuthView(view) {
    $('form-login').hidden = view !== 'login';
    $('form-forgot').hidden = view !== 'forgot';
    $('form-newpass').hidden = view !== 'newpass';
    if (view !== 'newpass') showAuthMsg('');
    const first = { login: 'login-email', forgot: 'forgot-email', newpass: 'newpass-1' }[view];
    setTimeout(() => $(first) && $(first).focus(), 0);
  }

  function showAuthMsg(text, kind) {
    const el = $('auth-message');
    if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
    const cls = kind === 'ok' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
      : kind === 'info' ? 'bg-sky-500/10 text-sky-300 border-sky-500/30'
      : 'bg-red-500/10 text-red-300 border-red-500/30';
    el.className = `text-sm rounded-lg p-3 mb-4 border ${cls}`;
    el.textContent = text;
  }

  function stripAuthHash() {
    if (/access_token|refresh_token|type=|error=/.test(location.hash) || /[?&]code=/.test(location.search)) {
      history.replaceState(null, '', location.pathname);
    }
  }

  function enqueueAuth(event, session) {
    S.authChain = S.authChain.then(() => onAuth(event, session)).catch((e) => console.error('[FlowTask] auth', e));
  }

  async function onAuth(event, session) {
    if (event === 'PASSWORD_RECOVERY') S.forceNewPass = true;
    if (!session) {
      teardown();
      showScreen('auth');
      // só volta ao login se nenhum formulário de autenticação estiver aberto: assim um aviso já exibido
      // (ex.: "conta desativada") não é apagado pelo SIGNED_OUT que chega logo depois
      if ($('form-newpass').hidden && $('form-login').hidden && $('form-forgot').hidden) showAuthView('login');
      if (S.pendingNotice) { showAuthMsg(S.pendingNotice); S.pendingNotice = null; stripAuthHash(); }
      return;
    }
    stripAuthHash();
    if (event === 'TOKEN_REFRESHED') return;
    if (S.bootedUid === session.user.id && event !== 'PASSWORD_RECOVERY') return;
    await boot(session);
  }

  async function boot(session) {
    showScreen('loading');
    const { data: prof, error } = await S.sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) {
      teardown();
      await S.sb.auth.signOut();
      showScreen('auth'); showAuthView('login');
      showAuthMsg(friendlyError(error));
      return;
    }
    if (!prof || !prof.is_active) {
      teardown();
      await S.sb.auth.signOut();
      showScreen('auth'); showAuthView('login');
      showAuthMsg('Sua conta está desativada ou sem acesso. Procure um administrador.');
      return;
    }
    S.me = prof;
    if (S.forceNewPass || prof.must_change_password) {
      showScreen('auth'); showAuthView('newpass');
      if (prof.must_change_password) showAuthMsg('Por segurança, defina uma nova senha para continuar.', 'info');
      return;
    }
    await enterApp();
  }

  async function enterApp() {
    try {
      await loadAll();
    } catch (e) {
      teardown();
      await S.sb.auth.signOut();
      showScreen('auth'); showAuthView('login');
      showAuthMsg(friendlyError(e));
      return;
    }
    S.bootedUid = S.me.id;
    subscribeRealtime();
    renderHeader();
    populateUserFilter();
    renderAll();
    switchTab(S.tab);
    showScreen('app');
  }

  function teardown() {
    // idempotente: o SIGNED_OUT chega depois do logout() e não pode apagar o que a pessoa já digitou no login
    const hadSession = !!(S.me || S.bootedUid);
    if (S.channel) { try { S.sb.removeChannel(S.channel); } catch (_) { /* ignore */ } S.channel = null; }
    clearInterval(S.pollTimer); S.pollTimer = null; S.rtOk = false;
    S.me = null; S.profiles = []; S.tasks = []; S.pmap = new Map(); S.bootedUid = null;
    ['col-todo', 'col-in_progress', 'col-done', 'users-list', 'calendar-grid', 'stat-by-user'].forEach((id) => $(id).replaceChildren());
    closeModal('modal-task'); closeModal('modal-export');
    if (hadSession) { $('form-login').reset(); $('form-newpass').reset(); }
  }

  async function logout() {
    teardown();
    await S.sb.auth.signOut();
    showScreen('auth'); showAuthView('login');
  }

  function wireAuth() {
    $('form-login').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('login-email').value.trim();
      const password = $('login-password').value;
      if (!EMAIL_RE.test(email) || !password) return showAuthMsg('Informe e-mail e senha.');
      busy($('btn-login'), async () => {
        showAuthMsg('');
        const { error } = await S.sb.auth.signInWithPassword({ email, password });
        if (error) showAuthMsg(friendlyError(error));
        $('login-password').value = '';
      });
    });
    $('link-forgot').addEventListener('click', () => { $('forgot-email').value = $('login-email').value; showAuthView('forgot'); });
    $('link-back-login').addEventListener('click', () => showAuthView('login'));
    $('form-forgot').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('forgot-email').value.trim();
      if (!EMAIL_RE.test(email)) return showAuthMsg('Informe um e-mail válido.');
      busy($('btn-forgot'), async () => {
        const { error } = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (error && (error.status === 429 || /rate limit/i.test(error.message))) return showAuthMsg(friendlyError(error));
        if (error) console.error('[FlowTask] reset', error);
        // resposta idêntica exista o e-mail ou não (evita revelar quem tem conta)
        showAuthMsg('Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha em instantes.', 'ok');
      });
    });
    $('form-newpass').addEventListener('submit', (e) => {
      e.preventDefault();
      const p1 = $('newpass-1').value, p2 = $('newpass-2').value;
      if (p1.length < MIN_PASSWORD) return showAuthMsg(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
      if (p1 !== p2) return showAuthMsg('As senhas não coincidem.');
      busy($('btn-newpass'), async () => {
        const { error } = await S.sb.auth.updateUser({ password: p1 });
        if (error) return showAuthMsg(friendlyError(error));
        if (S.me && S.me.must_change_password) {
          const { error: e2 } = await S.sb.from('profiles').update({ must_change_password: false }).eq('id', S.me.id);
          if (e2) return showAuthMsg(friendlyError(e2));
        }
        S.forceNewPass = false;
        $('form-newpass').reset();
        showAuthMsg('');
        toast('Senha definida com sucesso.', 'success');
        await enterApp();
      });
    });
    $('link-newpass-cancel').addEventListener('click', logout);
    $('btn-logout').addEventListener('click', logout);
  }

  // ------------------------------------------------------------------ dados
  async function loadProfiles() {
    const { data, error } = await S.sb.from('profiles').select('*').order('full_name', { ascending: true });
    if (error) throw error;
    S.profiles = data || [];
    rebuildProfileMap();
  }
  async function loadTasks() {
    const { data, error } = await S.sb.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    S.tasks = data || [];
    S.lastLoad = Date.now();
  }
  async function loadAll() { await Promise.all([loadProfiles(), loadTasks()]); }

  function mergeTask(row) {
    const i = S.tasks.findIndex((t) => t.id === row.id);
    if (i >= 0) S.tasks[i] = row; else S.tasks.unshift(row);
  }

  // ------------------------------------------------------------------ tempo real
  function setRtStatus(ok) {
    S.rtOk = ok;
    const el = $('rt-status');
    el.hidden = false;
    el.className = 'text-[10px] px-2 py-0.5 rounded-full border ' + (ok
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
      : 'bg-amber-500/10 text-amber-400 border-amber-500/30');
    el.textContent = ok ? '● Ao vivo' : '● Reconectando…';
    el.title = ok ? 'Alterações dos colegas aparecem automaticamente' : 'Sem tempo real no momento; atualizando a cada 30 s';
    clearInterval(S.pollTimer);
    S.pollTimer = ok ? null : setInterval(refreshQuietly, 30000);
  }

  async function refreshQuietly() {
    if (!S.me) return;
    try { await loadAll(); afterDataChange(); } catch (e) { console.error('[FlowTask] refresh', e); }
  }

  function subscribeRealtime() {
    if (S.channel) S.sb.removeChannel(S.channel);
    S.channel = S.sb.channel('flowtask-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, onTaskChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, onProfileChange)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { setRtStatus(true); refreshQuietly(); }
        else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) setRtStatus(false);
      });
  }

  function onTaskChange(p) {
    if (!S.me) return;
    if (p.eventType === 'DELETE') {
      const id = p.old && p.old.id;
      const existed = S.tasks.some((t) => t.id === id);
      S.tasks = S.tasks.filter((t) => t.id !== id);
      if (existed) toast('Uma tarefa foi excluída.');
    } else if (p.new && p.new.id) {
      const isNew = !S.tasks.some((t) => t.id === p.new.id);
      mergeTask(p.new);
      if (isNew && p.new.created_by !== S.me.id) toast(`Nova tarefa: ${p.new.title}`);
    }
    afterDataChange();
  }

  function onProfileChange(p) {
    if (!S.me) return;
    if (p.eventType === 'DELETE') S.profiles = S.profiles.filter((u) => u.id !== (p.old && p.old.id));
    else if (p.new && p.new.id) {
      const i = S.profiles.findIndex((u) => u.id === p.new.id);
      if (i >= 0) S.profiles[i] = p.new; else S.profiles.push(p.new);
      S.profiles.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'pt-BR'));
      if (p.new.id === S.me.id) {
        if (!p.new.is_active) {
          logout().then(() => showAuthMsg('Sua conta foi desativada por um administrador.'));
          return;
        }
        if (p.new.role !== S.me.role) toast(`Seu nível de acesso agora é: ${ROLE_LABEL[p.new.role]}.`);
        S.me = p.new;
        renderHeader();
      }
    }
    rebuildProfileMap();
    populateUserFilter();
    afterDataChange();
  }

  let raf = 0;
  function afterDataChange() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderAll);
  }

  // ------------------------------------------------------------------ navegação
  function switchTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.tab-content').forEach((el) => { el.hidden = el.id !== `tab-${tab}`; });
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('text-brand-500', active);
      btn.classList.toggle('bg-brand-500/10', active);
      btn.classList.toggle('text-zinc-400', !active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    });
    renderAll();
  }

  function renderHeader() {
    const roleCls = isAdmin() ? 'text-brand-400' : 'text-zinc-400';
    const name = S.me.full_name || S.me.email;
    $('me-name').textContent = name; $('me-name').title = S.me.email;
    $('me-role').textContent = ROLE_LABEL[S.me.role]; $('me-role').className = `text-[10px] font-semibold uppercase tracking-wider ${roleCls}`;
    $('me-name-m').textContent = name;
    $('me-role-m').textContent = ROLE_LABEL[S.me.role]; $('me-role-m').className = `font-semibold ${roleCls}`;
    $('user-create-panel').hidden = !isAdmin();
  }

  function renderAll() {
    if (!S.me) return;
    if (S.tab === 'kanban') renderKanban();
    else if (S.tab === 'calendar') renderCalendar();
    else if (S.tab === 'users') renderUsers();
    else if (S.tab === 'stats') renderStats();
  }

  // ------------------------------------------------------------------ kanban
  function populateUserFilter() {
    const sel = $('f-user'); const cur = sel.value;
    sel.replaceChildren(
      h('option', { value: 'all', text: 'Todos os membros' }),
      h('option', { value: 'none', text: 'Sem responsável' }),
      ...S.profiles.filter((p) => p.is_active).map((p) => h('option', { value: p.id, text: p.full_name || p.email })),
    );
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'all';
  }

  function filteredTasks() {
    const u = $('f-user').value, st = $('f-status').value, pr = $('f-priority').value;
    const d1 = $('f-start').value, d2 = $('f-end').value;
    return S.tasks.filter((t) => {
      if (u === 'none' ? t.assignee_id : (u !== 'all' && t.assignee_id !== u)) return false;
      if (st !== 'all' && t.status !== st) return false;
      if (pr !== 'all' && t.priority !== pr) return false;
      if (d1 || d2) { // com filtro de prazo, tarefas sem prazo não entram
        if (!t.due_date) return false;
        if (d1 && t.due_date < d1) return false;
        if (d2 && t.due_date > d2) return false;
      }
      return true;
    });
  }

  function sortTasks(a, b) {
    return (PRIORITY[b.priority].rank - PRIORITY[a.priority].rank)
      || ((a.due_date || '9999-99-99') < (b.due_date || '9999-99-99') ? -1 : (a.due_date || '9999-99-99') > (b.due_date || '9999-99-99') ? 1 : 0)
      || (a.created_at < b.created_at ? 1 : -1);
  }

  function renderKanban() {
    const list = filteredTasks();
    const stFilter = $('f-status').value;
    STATUS_ORDER.forEach((st) => {
      const wrap = document.querySelector(`[data-col-wrap="${st}"]`);
      wrap.hidden = stFilter !== 'all' && stFilter !== st;
      const items = list.filter((t) => t.status === st).sort(sortTasks);
      $(`count-${st}`).textContent = items.length;
      $(`col-${st}`).replaceChildren(...(items.length ? items.map(taskCard) : [h('p', { class: 'text-xs text-zinc-600 text-center py-6', text: 'Nenhuma tarefa' })]));
    });
    const grid = $('kanban-grid');
    grid.classList.toggle('md:grid-cols-3', stFilter === 'all');
    grid.classList.toggle('md:grid-cols-1', stFilter !== 'all');
  }

  function taskCard(t) {
    const pr = PRIORITY[t.priority];
    const editable = canEdit(t);
    const overdue = t.due_date && t.due_date < todayStr() && t.status !== 'done';
    const who = profileName(t.assignee_id);
    const statusSel = h('select', {
      class: 'ft-input-sm !py-1 !text-[11px] w-full mt-2', 'aria-label': `Status da tarefa ${t.title}`, disabled: !editable,
      title: editable ? 'Alterar status' : 'Você não pode alterar esta tarefa',
      onchange: (e) => changeStatus(t.id, e.target.value),
      onclick: (e) => e.stopPropagation(),
    }, STATUS_ORDER.map((s) => h('option', { value: s, selected: s === t.status, text: STATUS[s] })));

    const card = h('div', {
      class: `bg-[#1e1e1e] border border-[#2a2a2a] border-l-4 ${pr.bar} p-4 rounded-xl shadow-sm hover:border-brand-500/40 transition-all ${editable ? 'cursor-grab active:cursor-grabbing' : ''}`,
      draggable: editable ? 'true' : null, 'data-task-id': t.id,
      onclick: () => openTaskModal(t.id),
      ondragstart: null,
    },
      h('div', { class: 'flex items-start justify-between gap-2 mb-1' },
        h('button', { type: 'button', class: 'text-left font-semibold text-sm text-zinc-100 break-words min-w-0 hover:text-brand-400', text: t.title }),
        h('span', { class: `shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${pr.badge}`, text: pr.label }),
      ),
      t.description ? h('p', { class: 'text-xs text-zinc-400 mb-2 line-clamp-3 break-words whitespace-pre-line', text: t.description }) : null,
      h('div', { class: 'text-[10px] text-zinc-500 flex justify-between items-center gap-2 border-t border-[#2a2a2a]/40 pt-2' },
        h('span', { class: 'truncate', text: `👤 ${who || 'Sem responsável'}` }),
        h('span', { class: overdue ? 'text-red-400 font-semibold shrink-0' : 'shrink-0', text: `📅 ${t.due_date ? fmtDate(t.due_date) : 'Sem prazo'}${overdue ? ' (atrasada)' : ''}` }),
      ),
      statusSel,
    );
    card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; });
    return card;
  }

  async function changeStatus(id, status) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t || t.status === status || !STATUS[status]) return renderKanban();
    if (!canEdit(t)) { toast('Você não tem permissão para alterar esta tarefa.', 'error'); return renderKanban(); }
    const prev = t.status;
    t.status = status; renderKanban(); // otimista
    const { data, error } = await S.sb.from('tasks').update({ status }).eq('id', id).select().maybeSingle();
    if (error || !data) {
      t.status = prev; renderKanban();
      return toast(error ? friendlyError(error) : 'Você não tem permissão para alterar esta tarefa.', 'error');
    }
    mergeTask(data); afterDataChange();
    toast(`Movida para "${STATUS[status]}".`, 'success');
  }

  function wireKanban() {
    ['f-user', 'f-status', 'f-priority', 'f-start', 'f-end'].forEach((id) => $(id).addEventListener('change', renderKanban));
    $('btn-clear-filters').addEventListener('click', () => {
      $('f-user').value = 'all'; $('f-status').value = 'all'; $('f-priority').value = 'all';
      $('f-start').value = ''; $('f-end').value = ''; renderKanban();
    });
    document.querySelectorAll('.kanban-col').forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('bg-brand-500/5'); });
      col.addEventListener('dragleave', () => col.classList.remove('bg-brand-500/5'));
      col.addEventListener('drop', (e) => {
        e.preventDefault(); col.classList.remove('bg-brand-500/5');
        const id = e.dataTransfer.getData('text/plain');
        if (UUID_RE.test(id)) changeStatus(id, col.dataset.col);
      });
    });
  }

  // ------------------------------------------------------------------ calendário
  function renderCalendar() {
    const y = S.calYear, m = S.calMonth;
    $('calendar-month-year').textContent = `${MONTHS[m]} ${y}`;
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const today = todayStr();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(h('div', { class: 'h-16 sm:h-24 bg-[#121212] border border-[#2a2a2a]/30 rounded' }));
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
      const dayTasks = S.tasks.filter((t) => t.due_date === ds).sort(sortTasks);
      cells.push(h('div', { class: `h-16 sm:h-24 bg-[#1e1e1e] border ${ds === today ? 'border-brand-500' : 'border-[#2a2a2a]'} rounded p-1 text-left overflow-y-auto` },
        h('span', { class: `text-xs font-bold ${ds === today ? 'text-brand-400' : 'text-zinc-400'}`, text: d }),
        dayTasks.map((t) => h('button', {
          type: 'button', title: `${t.title} — ${PRIORITY[t.priority].label} — ${STATUS[t.status]}`,
          class: `flex items-center gap-1 w-full text-left text-[9px] sm:text-[10px] bg-brand-500/15 text-brand-300 hover:bg-brand-500/30 rounded px-1 truncate mt-1 ${t.status === 'done' ? 'line-through opacity-60' : ''}`,
          onclick: () => openTaskModal(t.id),
        }, h('span', { class: `shrink-0 inline-block w-1.5 h-1.5 rounded-full ${PRIORITY[t.priority].dot}` }), h('span', { class: 'truncate', text: t.title }))),
      ));
    }
    $('calendar-grid').replaceChildren(...cells);
  }

  function shiftMonth(delta) {
    const d = new Date(S.calYear, S.calMonth + delta, 1);
    S.calYear = d.getFullYear(); S.calMonth = d.getMonth(); renderCalendar();
  }

  // ------------------------------------------------------------------ modal de tarefa
  function openModal(id) { const el = $(id); show(el, 'flex'); const f = el.querySelector('input:not([type=hidden]):not(:disabled), select:not(:disabled)'); if (f) f.focus(); }
  function closeModal(id) { const el = $(id); hide(el); el.classList.remove('flex'); }

  function fillAssigneeOptions(selected, restrictToSelf) {
    const sel = $('task-assignee');
    let people = S.profiles.filter((p) => p.is_active || p.id === selected);
    if (restrictToSelf) people = people.filter((p) => p.id === S.me.id);
    sel.replaceChildren(
      h('option', { value: '', text: 'Sem responsável' }),
      ...people.map((p) => h('option', { value: p.id, text: (p.full_name || p.email) + (p.is_active ? '' : ' (inativo)') })),
    );
    sel.value = selected || '';
  }

  function openTaskModal(id) {
    const t = id ? S.tasks.find((x) => x.id === id) : null;
    const editing = !!t;
    const editable = !editing || canEdit(t);
    $('modal-title').textContent = !editing ? 'Nova tarefa' : (editable ? 'Editar tarefa' : 'Detalhes da tarefa');
    $('task-id').value = editing ? t.id : '';
    $('task-title').value = editing ? t.title : '';
    $('task-desc').value = editing ? t.description : '';
    $('task-priority').value = editing ? t.priority : 'medium';
    $('task-duedate').value = editing ? (t.due_date || '') : '';
    $('task-status').value = editing ? t.status : 'todo';
    fillAssigneeOptions(editing ? t.assignee_id : (isAdmin() ? '' : ''), !isAdmin() && !editing);

    ['task-title', 'task-desc', 'task-duedate', 'task-status'].forEach((f) => { $(f).disabled = !editable; });
    $('task-priority').disabled = !editable || (editing && !canChangePriority(t));
    $('task-assignee').disabled = !editable || !isAdmin() && editing;
    $('btn-task-save').hidden = !editable;
    $('btn-task-delete').hidden = !(editing && isAdmin());

    const hint = $('task-hint');
    let hintText = '';
    if (!editable) hintText = 'Você pode visualizar esta tarefa, mas só o criador, o responsável ou um administrador pode editá-la.';
    else if (!isAdmin()) hintText = editing
      ? 'Apenas administradores alteram o responsável. A prioridade só pode ser alterada por quem criou a tarefa.'
      : 'Como membro, você pode deixar a tarefa sem responsável ou atribuí-la a você. Administradores atribuem aos demais.';
    hint.textContent = hintText; hint.classList.toggle('hidden', !hintText);

    const meta = $('task-meta');
    if (editing) {
      meta.textContent = `Criada por ${profileName(t.created_by) || 'usuário removido'} em ${fmtDateTime(t.created_at)} · Última atualização por ${profileName(t.updated_by) || 'usuário removido'} em ${fmtDateTime(t.updated_at)}`;
      meta.classList.remove('hidden');
    } else meta.classList.add('hidden');
    openModal('modal-task');
  }

  async function saveTask() {
    const id = $('task-id').value;
    const title = $('task-title').value.trim();
    const description = $('task-desc').value.trim();
    const priority = $('task-priority').value, status = $('task-status').value;
    const due_date = $('task-duedate').value || null;
    const assignee_id = $('task-assignee').value || null;

    if (!title) return toast('Informe o título da tarefa.', 'error');
    if (title.length > 200) return toast('O título pode ter no máximo 200 caracteres.', 'error');
    if (description.length > 2000) return toast('A descrição pode ter no máximo 2000 caracteres.', 'error');
    if (!PRIORITY[priority] || !STATUS[status]) return toast('Prioridade ou status inválido.', 'error');
    if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return toast('Prazo inválido.', 'error');
    if (assignee_id && !UUID_RE.test(assignee_id)) return toast('Responsável inválido.', 'error');

    let res;
    if (!id) {
      res = await S.sb.from('tasks').insert({ title, description, priority, status, due_date, assignee_id }).select().maybeSingle();
    } else {
      const t = S.tasks.find((x) => x.id === id);
      const patch = { title, description, status, due_date };
      if (canChangePriority(t)) patch.priority = priority;
      if (isAdmin()) patch.assignee_id = assignee_id;
      res = await S.sb.from('tasks').update(patch).eq('id', id).select().maybeSingle();
    }
    if (res.error) return toast(friendlyError(res.error), 'error');
    if (!res.data) return toast('Você não tem permissão para alterar esta tarefa.', 'error');
    mergeTask(res.data); afterDataChange();
    closeModal('modal-task');
    toast(id ? 'Tarefa atualizada.' : 'Tarefa criada.', 'success');
  }

  async function deleteTask() {
    const id = $('task-id').value;
    const t = S.tasks.find((x) => x.id === id);
    if (!t || !confirm(`Excluir a tarefa "${t.title}"? Esta ação não pode ser desfeita.`)) return;
    const { data, error } = await S.sb.from('tasks').delete().eq('id', id).select();
    if (error) return toast(friendlyError(error), 'error');
    if (!data || !data.length) return toast('Você não tem permissão para excluir tarefas.', 'error');
    S.tasks = S.tasks.filter((x) => x.id !== id); afterDataChange();
    closeModal('modal-task');
    toast('Tarefa excluída.', 'success');
  }

  // ------------------------------------------------------------------ usuários
  function renderUsers() {
    const admin = isAdmin();
    $('users-list').replaceChildren(...S.profiles.map((u) => {
      const self = u.id === S.me.id;
      const info = h('div', { class: 'min-w-0' },
        h('p', { class: 'text-sm font-semibold text-zinc-200 flex flex-wrap items-center gap-2' },
          h('span', { class: 'truncate', text: u.full_name || u.email }),
          h('span', { class: `text-[10px] font-semibold px-2 py-0.5 rounded-full border ${u.role === 'admin' ? 'bg-brand-500/10 text-brand-400 border-brand-500/30' : 'bg-[#222] text-zinc-400 border-[#2a2a2a]'}`, text: ROLE_LABEL[u.role] }),
          u.is_active ? null : h('span', { class: 'text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-red-500/10 text-red-400 border-red-500/30', text: 'Desativado' }),
          self ? h('span', { class: 'text-[10px] text-zinc-500', text: '(você)' }) : null,
        ),
        h('p', { class: 'text-xs text-zinc-500 truncate', text: `${u.job_title ? u.job_title + ' — ' : ''}${u.email}` }),
      );
      const controls = admin ? h('div', { class: 'flex flex-wrap items-center gap-2' },
        h('select', { class: 'ft-input-sm', 'aria-label': `Nível de acesso de ${u.full_name || u.email}`, disabled: self,
          onchange: (e) => changeRole(u, e.target.value) },
          ['member', 'admin'].map((r) => h('option', { value: r, selected: r === u.role, text: ROLE_LABEL[r] }))),
        h('button', { type: 'button', class: 'ft-btn ft-btn-dark !px-3 !py-1.5 !text-xs', disabled: self, text: u.is_active ? 'Desativar' : 'Reativar', onclick: () => toggleActive(u) }),
        h('button', { type: 'button', class: 'ft-btn ft-btn-dark !px-3 !py-1.5 !text-xs', disabled: self, text: 'Redefinir senha', onclick: () => resetPassword(u) }),
      ) : null;
      return h('div', { class: `flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-[#121212] border border-[#2a2a2a] rounded-lg ${u.is_active ? '' : 'opacity-60'}` }, info, controls);
    }));
  }

  async function updateProfile(u, patch) {
    const { data, error } = await S.sb.from('profiles').update(patch).eq('id', u.id).select().maybeSingle();
    if (error || !data) { toast(error ? friendlyError(error) : 'Você não tem permissão para esta ação.', 'error'); renderUsers(); return false; }
    const i = S.profiles.findIndex((x) => x.id === u.id); if (i >= 0) S.profiles[i] = data;
    rebuildProfileMap(); populateUserFilter(); renderUsers();
    return true;
  }
  async function changeRole(u, role) {
    if (!confirm(`Alterar o nível de acesso de ${u.full_name || u.email} para "${ROLE_LABEL[role]}"?`)) return renderUsers();
    if (await updateProfile(u, { role })) toast('Nível de acesso atualizado.', 'success');
  }
  async function toggleActive(u) {
    const next = !u.is_active;
    if (!confirm(next ? `Reativar ${u.full_name || u.email}?` : `Desativar ${u.full_name || u.email}? A pessoa perde o acesso imediatamente.`)) return;
    try {
      // via função de servidor: além de marcar o perfil, bloqueia o login no Supabase Auth
      await callAdminFn({ action: 'set_active', user_id: u.id, active: next });
      await loadProfiles(); populateUserFilter(); renderUsers();
      toast(next ? 'Usuário reativado.' : 'Usuário desativado.', 'success');
    } catch (e) { toast(e.custom ? e.message : friendlyError(e), 'error'); renderUsers(); }
  }

  async function callAdminFn(body) {
    const { data, error } = await S.sb.functions.invoke('admin-users', { body });
    if (error) {
      let msg = null;
      try { const j = await error.context.json(); msg = j && j.error; } catch (_) { /* ignore */ }
      if (!msg && error.context && error.context.status === 404) msg = 'A função "admin-users" ainda não foi publicada no Supabase (veja o README, passo 5).';
      throw Object.assign(new Error(msg || 'Falha ao chamar a função de administração.'), { custom: true });
    }
    if (data && data.error) throw Object.assign(new Error(data.error), { custom: true });
    return data;
  }

  async function resetPassword(u) {
    const pw = prompt(`Nova senha temporária para ${u.full_name || u.email} (mínimo ${MIN_PASSWORD} caracteres).\nA pessoa será obrigada a trocá-la no próximo acesso.`);
    if (pw == null) return;
    if (pw.length < MIN_PASSWORD) return toast(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`, 'error');
    try { await callAdminFn({ action: 'reset_password', user_id: u.id, password: pw }); toast('Senha temporária definida. Informe-a à pessoa por um canal seguro.', 'success'); await loadProfiles(); renderUsers(); }
    catch (e) { toast(e.custom ? e.message : friendlyError(e), 'error'); }
  }

  async function createUser() {
    const full_name = $('uc-name').value.trim(), email = $('uc-email').value.trim().toLowerCase();
    const job_title = $('uc-title').value.trim(), role = $('uc-role').value, mode = $('uc-mode').value, password = $('uc-pass').value;
    if (!full_name) return toast('Informe o nome.', 'error');
    if (!EMAIL_RE.test(email)) return toast('Informe um e-mail válido.', 'error');
    if (mode === 'password' && password.length < MIN_PASSWORD) return toast(`A senha temporária precisa ter pelo menos ${MIN_PASSWORD} caracteres.`, 'error');
    try {
      await callAdminFn({ action: mode === 'invite' ? 'invite' : 'create', email, full_name, job_title, role, password: mode === 'password' ? password : undefined });
      $('form-user-create').reset(); syncCreateMode();
      toast(mode === 'invite' ? 'Convite enviado.' : 'Usuário cadastrado. Informe a senha temporária à pessoa por um canal seguro.', 'success');
      await loadProfiles(); populateUserFilter(); renderUsers();
    } catch (e) { toast(e.custom ? e.message : friendlyError(e), 'error'); }
  }
  function syncCreateMode() { $('uc-pass-wrap').hidden = $('uc-mode').value !== 'password'; }

  // ------------------------------------------------------------------ estatísticas
  function renderStats() {
    const total = S.tasks.length, done = S.tasks.filter((t) => t.status === 'done').length;
    const today = todayStr();
    $('stat-total').textContent = total;
    $('stat-rate').textContent = total ? `${Math.round((done / total) * 100)}%` : '0%';
    $('stat-users').textContent = S.profiles.filter((p) => p.is_active).length;
    $('stat-progress').textContent = S.tasks.filter((t) => t.status === 'in_progress').length;
    $('stat-overdue').textContent = S.tasks.filter((t) => t.due_date && t.due_date < today && t.status !== 'done').length;
    $('stat-high').textContent = S.tasks.filter((t) => t.priority === 'high' && t.status !== 'done').length;

    const rows = S.profiles.filter((p) => p.is_active || S.tasks.some((t) => t.assignee_id === p.id))
      .map((p) => ({ name: p.full_name || p.email, id: p.id }));
    rows.push({ name: 'Sem responsável', id: null });
    $('stat-by-user').replaceChildren(...rows.map((r) => {
      const mine = S.tasks.filter((t) => (t.assignee_id || null) === r.id);
      const d = mine.filter((t) => t.status === 'done').length;
      const pct = mine.length ? Math.round((d / mine.length) * 100) : 0;
      return h('div', {},
        h('div', { class: 'flex justify-between text-xs mb-1' }, h('span', { class: 'text-zinc-300 truncate', text: r.name }), h('span', { class: 'text-zinc-500 shrink-0', text: `${d}/${mine.length} concluídas` })),
        h('div', { class: 'h-2 rounded bg-[#222] overflow-hidden' }, h('div', { class: 'h-full bg-brand-500', style: { width: `${pct}%` } })),
      );
    }));
  }

  // ------------------------------------------------------------------ exportação CSV
  /** RFC 4180 + proteção contra injeção de fórmulas (=, +, -, @) ao abrir no Excel. */
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function buildCsv(rows, sep) { return '\uFEFF' + rows.map((r) => r.map(csvCell).join(sep)).join('\r\n') + '\r\n'; }

  function exportCsv() {
    const start = $('export-start').value, end = $('export-end').value, type = $('export-type').value, sep = $('export-sep').value === ',' ? ',' : ';';
    let rows, filename;
    if (type === 'users') {
      rows = [['ID', 'Nome', 'E-mail', 'Cargo', 'Nível de acesso', 'Ativo']];
      S.profiles.forEach((u) => rows.push([u.id, u.full_name, u.email, u.job_title, ROLE_LABEL[u.role], u.is_active ? 'Sim' : 'Não']));
      filename = 'relatorio_usuarios';
    } else {
      rows = [['ID', 'Título', 'Descrição', 'Prioridade', 'Status', 'Prazo', 'Responsável', 'Criada por', 'Criada em', 'Última atualização']];
      let list = S.tasks.slice();
      if (type === 'done_tasks') list = list.filter((t) => t.status === 'done');
      if (start || end) list = list.filter((t) => t.due_date && (!start || t.due_date >= start) && (!end || t.due_date <= end));
      list.sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1);
      list.forEach((t) => rows.push([t.id, t.title, t.description, PRIORITY[t.priority].label, STATUS[t.status], fmtDate(t.due_date),
        profileName(t.assignee_id) || 'Sem responsável', profileName(t.created_by) || '', fmtDateTime(t.created_at), fmtDateTime(t.updated_at)]));
      filename = type === 'done_tasks' ? 'relatorio_tarefas_concluidas' : 'relatorio_tarefas';
    }
    const blob = new Blob([buildCsv(rows, sep)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${filename}_${todayStr()}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeModal('modal-export');
    toast(`${rows.length - 1} registro(s) exportado(s).`, 'success');
  }

  // ------------------------------------------------------------------ inicialização
  function wireUi() {
    document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
    ['modal-task', 'modal-export'].forEach((id) => $(id).addEventListener('mousedown', (e) => { if (e.target === $(id)) closeModal(id); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal('modal-task'); closeModal('modal-export'); } });

    $('btn-new-task').addEventListener('click', () => openTaskModal(null));
    $('btn-export').addEventListener('click', () => openModal('modal-export'));
    $('form-export').addEventListener('submit', (e) => { e.preventDefault(); exportCsv(); });
    $('form-task').addEventListener('submit', (e) => { e.preventDefault(); busy($('btn-task-save'), saveTask); });
    $('btn-task-delete').addEventListener('click', () => busy($('btn-task-delete'), deleteTask));
    $('cal-prev').addEventListener('click', () => shiftMonth(-1));
    $('cal-next').addEventListener('click', () => shiftMonth(1));
    $('uc-mode').addEventListener('change', syncCreateMode);
    $('form-user-create').addEventListener('submit', (e) => { e.preventDefault(); busy($('btn-user-create'), createUser); });
    syncCreateMode();
    wireKanban();
    wireAuth();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.me && Date.now() - S.lastLoad > 30000) refreshQuietly();
    });

    // logo opcional: o build define HAS_LOGO quando existe public/logo.png; sem logo, mostra o nome em texto
    if ((window.FLOWTASK_CONFIG || {}).HAS_LOGO) {
      [['auth-logo', 'auth-brand'], ['app-logo', 'app-brand']].forEach(([imgId, brandId]) => {
        const img = $(imgId), brand = $(brandId);
        img.addEventListener('error', () => { img.hidden = true; brand.classList.remove('hidden'); });
        img.addEventListener('load', () => { img.hidden = false; brand.classList.add('hidden'); });
        img.src = 'logo.png';
      });
    }
  }

  function init() {
    wireUi();
    const cfg = window.FLOWTASK_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) return showScreen('config');
    S.forceNewPass = /(^|[#&])type=(recovery|invite)/.test(location.hash);
    // links de convite/recuperação vencidos ou já usados voltam com #error=...
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (hashParams.get('error')) {
      S.pendingNotice = /expired|invalid/i.test(`${hashParams.get('error_code')} ${hashParams.get('error_description')}`)
        ? 'Este link expirou ou já foi utilizado. Use "Esqueci minha senha" para receber um novo.'
        : 'Não foi possível validar o link de acesso.';
    }
    S.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });
    // Nunca fazer chamadas ao Supabase direto dentro deste callback (risco de deadlock): vai para a fila.
    S.sb.auth.onAuthStateChange((event, session) => setTimeout(() => enqueueAuth(event, session), 0));
    S.sb.auth.getSession().then(({ data }) => { if (!data.session) enqueueAuth('INITIAL_SESSION', null); });
  }

  init();
})();
