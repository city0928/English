(function (root) {
  'use strict';
  const { SyncController, accountStorageKey } = root.EnglishSyncCore;
  const SESSION_KEY = 'departureEnglish.cloud.session.v1';
  const apiOrigin = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : document.querySelector('meta[name="english-sync-api"]').content;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
  let rememberedSession = read(SESSION_KEY);
  if (!rememberedSession || rememberedSession.api !== apiOrigin || typeof rememberedSession.user?.id !== 'string' || typeof rememberedSession.user.username !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rememberedSession.token || '')) rememberedSession = null;
  // Start as guest. Only the tab owning this account's Web Lock may load or write its cache.
  let session = null, heldLock = null, authGeneration = 0;
  let controller = null, hooks = null, applying = false, status = 'guest', timer = null, dialog = null, authMode = 'login', choice = null, pendingMeta = null;
  const key = () => accountStorageKey(session?.user.id);
  const metadata = () => controller ? { revision: controller.revision, dirty: controller.dirty, lastSyncAt: controller.lastSyncAt } : pendingMeta || read(key())?.__cloudSync || { revision: 0, dirty: false };
  function pack(state) {
    return session ? { ...state, __cloudSync: { ...metadata(), dirty: applying ? !!metadata().dirty : true } } : state;
  }
  function saveMetadata(meta) {
    if (hooks && session && !write(key(), { ...hooks.snapshot(), __cloudSync: meta })) hooks.storageFailed();
  }
  function reserveAccount(id) {
    if (heldLock?.id === id) return Promise.resolve(heldLock);
    if (!navigator.locks?.request) return Promise.reject(new Error('此浏览器暂不支持账号同步保护，请更新浏览器，或继续使用本机记录。'));
    return new Promise((resolve, reject) => {
      navigator.locks.request('departureEnglish.account.' + id, { ifAvailable: true }, async lock => {
        if (!lock) { resolve(null); return; }
        let release;
        const held = new Promise(done => { release = done; });
        resolve({ id, release });
        await held;
      }).catch(reject);
    });
  }
  const statuses = () => ({ guest:'仅保存在本机', loading:'正在读取记录', pending:'等待同步', saving:'正在同步', saved:'已同步', offline:navigator.onLine ? '暂未同步 · 本机已保存' : '离线 · 本机已保存', auth:'请重新登录', conflict:'有记录冲突', deferred:'回首页读取云端更新', 'too-large':'记录过大 · 请导出备份' });
  function updateStatus(next) {
    status = next;
    const button = document.getElementById('cloud-account'); if (!button) return;
    button.setAttribute('aria-label', '学习账号：' + (session?.user.username || '未登录') + '，' + statuses()[status]);
    button.querySelector('.cloud-name').textContent = session?.user.username || '登录 / 创建账号';
    button.querySelector('.cloud-status').textContent = statuses()[status] || '本机记录保留';
    button.querySelector('.cloud-dot').dataset.status = status;
  }
  async function request(path, method = 'GET', data, activeSession = session) {
    const headers = {};
    if (activeSession?.token) headers.Authorization = 'Bearer ' + activeSession.token;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(apiOrigin + '/api/sync/' + path, { method, headers, credentials: apiOrigin === location.origin ? 'same-origin' : 'omit', body: data === undefined ? undefined : JSON.stringify(data), signal: abort.signal, cache: 'no-store' });
      let body; try { body = await response.json(); } catch { throw new Error('同步服务暂时不可访问，请先使用本机记录。'); }
      if (!response.ok) throw Object.assign(new Error(body.error || '暂时无法同步，请稍后再试。'), { status: response.status, data: body });
      return body;
    } finally { clearTimeout(timeout); }
  }
  function applyState(raw) { applying = true; try { hooks.apply(raw); } finally { applying = false; } }
  function makeController(value, meta) {
    const activeSession = session;
    controller = new SyncController({
      api: { get: () => request('progress', 'GET', undefined, activeSession), put: (revision, state) => request('progress', 'PUT', { revision, state }, activeSession) },
      state: value, revision: meta.revision || 0, dirty: !!meta.dirty, lastSyncAt: meta.lastSyncAt,
      onApply: applyState, onStatus: updateStatus, onMeta: saveMetadata, onConflict: showConflict,
      canApply: () => hooks.canApply?.() !== false
    });
    return controller;
  }
  function show(html) { if (!dialog) return; dialog.innerHTML = '<div class="sync-inner">' + html + '</div>'; if (!dialog.open) dialog.showModal(); }
  const heading = (title, help = '') => '<div class="sync-heading"><div><h2>' + esc(title) + '</h2>' + (help ? '<p>' + esc(help) + '</p>' : '') + '</div><button class="sync-close" data-sync="close" aria-label="关闭账号窗口">×</button></div>';
  function close() { if (dialog?.open) dialog.close(); }
  function showAuth() {
    authGeneration++;
    const creating = authMode === 'register';
    show(heading('带着进度，换一台设备继续。', '使用用户名和自己设置的密码。') +
      '<div class="sync-tabs" role="tablist" aria-label="账号操作"><button role="tab" aria-selected="' + !creating + '" data-sync="login-tab">登录</button><button role="tab" aria-selected="' + creating + '" data-sync="register-tab">创建账号</button></div>' +
      '<form id="cloud-auth-form"><label class="sync-field">用户名<input name="username" autocomplete="username" minlength="2" maxlength="32" required value="' + esc(session?.user.username || '') + '" placeholder="例如：小林"></label>' +
      '<label class="sync-field">密码<input name="password" type="password" autocomplete="' + (creating ? 'new-password' : 'current-password') + '" minlength="8" maxlength="128" required placeholder="至少 8 个字符"></label>' +
      (creating ? '<label class="sync-field">再次输入密码<input name="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>' : '') +
      '<p id="cloud-auth-error" class="sync-error" role="alert"></p><button type="submit" class="button sync-submit">' + (creating ? '创建账号并继续' : '登录并同步') + '</button></form>' +
      '<p class="sync-help">用户名可用中文、字母、数字、下划线和短横线。<br>目前不提供邮箱找回，请记住密码，并定期导出学习记录。<br>不登录也可以继续在本机学习。</p>');
    dialog.querySelector('input[name=username]')?.focus();
  }
  function showAccount() {
    if (!session || status === 'auth') { authMode = 'login'; showAuth(); return; }
    const last = controller?.lastSyncAt ? new Date(controller.lastSyncAt).toLocaleString('zh-CN') : '尚未同步';
    show(heading('学习账号') + '<p class="sync-account-name">' + esc(session.user.username) + '</p><div class="sync-info">' + esc(statuses()[status]) + '<br>上次同步：' + esc(last) + '</div>' +
      (status === 'conflict' ? '<button class="button sync-submit" data-sync="show-conflict">处理记录冲突</button>' : '<button class="button sync-submit" data-sync="sync-now">立即同步</button>') +
      '<div class="sync-actions"><button class="button secondary" data-sync="export">导出学习记录</button><button class="button ghost" data-sync="logout">退出账号</button></div>' +
      '<p class="sync-help">退出后恢复访客的本机记录。尚未上传的修改会留在该账号的本机缓存，重新登录后可继续同步。</p>');
  }
  function hasRecords(value) { return value && ['completed','scores','weekly','review','mistakes','oral','notes','stages','stageSkills','maintenance'].some(field => Object.keys(value[field] || {}).length) || !!value?.favorites?.length; }
  function summary(value) { return Object.keys(value?.completed || {}).length + ' 节理解过关 · ' + Object.keys(value?.notes || {}).length + ' 份草稿 · ' + (value?.favorites || []).length + ' 个收藏'; }
  function chooseMigration(local, remote) {
    return new Promise(resolve => {
      choice = resolve;
      show(heading('选择从哪份记录继续', '本机访客记录会保留一份副本。') +
        '<button class="sync-choice" data-sync="migrate-cloud"><strong>' + (remote.state ? '使用云端记录' : '从空白账号开始') + '</strong><small>' + esc(summary(remote.state)) + '</small></button>' +
        '<button class="sync-choice" data-sync="migrate-local"><strong>复制本机记录到账号并上传</strong><small>' + esc(summary(local)) + (remote.state ? '；这会替换该账号目前的云端记录。' : '') + '</small></button>' +
        '<p class="sync-help">只有确认选择后才会切换记录；其他账号的数据不会被合并进来。</p>');
    });
  }
  function showConflict() {
    if (!controller?.conflict || !session) return;
    show(heading('另一台设备更新了记录', '本机修改已保留，请选择接下来采用哪份。') +
      '<button class="sync-choice" data-sync="conflict-cloud"><strong>采用云端记录</strong><small>' + esc(summary(controller.conflict.state)) + '；替换本机这份待上传修改。</small></button>' +
      '<button class="sync-choice" data-sync="conflict-local"><strong>采用本机记录并覆盖云端</strong><small>' + esc(summary(hooks.snapshot())) + '；其他设备下次同步会收到更新。</small></button>' +
      '<p class="sync-help">暂时不选也可以。建议先导出备份，再决定。</p><button class="button ghost sync-submit" data-sync="export">先导出本机备份</button>');
  }
  function activate(nextSession, value, meta, lease = null) {
    if (nextSession && (!lease || lease.id !== nextSession.user.id)) throw new Error('账号窗口未就绪，请重试。');
    const oldSession = session;
    clearTimeout(timer); controller?.stop(); controller = null;
    if (heldLock && heldLock !== lease) heldLock.release();
    heldLock = lease; session = nextSession; pendingMeta = meta;
    if (session) { if (!write(SESSION_KEY, session)) hooks.storageFailed(); }
    else { try { if (read(SESSION_KEY)?.token === oldSession?.token) localStorage.removeItem(SESSION_KEY); } catch { hooks.storageFailed(); } }
    hooks.setStorageKey(key()); applyState(value); pendingMeta = null;
    if (session) makeController(hooks.snapshot(), meta);
    updateStatus(session ? (meta.dirty ? 'pending' : 'saved') : 'guest');
  }
  async function signIn(form) {
    const generation = ++authGeneration;
    const username = form.elements.username.value, password = form.elements.password.value;
    const creating = authMode === 'register', button = form.querySelector('button[type=submit]'), error = document.getElementById('cloud-auth-error');
    if (creating && password !== form.elements.confirmation.value) { error.textContent = '两次输入的密码不一致。'; return; }
    button.disabled = true; button.textContent = creating ? '正在创建…' : '正在登录…'; error.textContent = '';
    let issued = null, lease = null;
    try {
      const result = await request(creating ? 'register' : 'login', 'POST', { username, password }, null); issued = { ...result, api: apiOrigin };
      if (generation !== authGeneration) return;
      form.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; });
      lease = await reserveAccount(issued.user.id);
      if (generation !== authGeneration) return;
      if (!lease) throw new Error('此账号已在另一个标签页使用。请关闭那个页面后再登录本页。');
      const remote = await request('progress', 'GET', undefined, issued), cached = read(accountStorageKey(issued.user.id)), meta = cached?.__cloudSync;
      if (generation !== authGeneration) return;
      let value = remote.state, desired = { revision: remote.revision, dirty: false, lastSyncAt: Date.now() };
      if (cached && meta?.dirty) { value = cached; desired = meta; }
      else if (!session && hasRecords(hooks.snapshot())) {
        const local = hooks.snapshot(), picked = await chooseMigration(local, remote);
        if (generation !== authGeneration || picked === 'cancel') return;
        if (picked === 'local') { value = local; desired.dirty = true; }
      }
      if (generation !== authGeneration) return;
      activate(issued, value, desired, lease); issued = null; lease = null; close();
      if (desired.dirty && cached?.__cloudSync?.dirty) await controller.pull(); else if (desired.dirty) await controller.flush();
      hooks.toast(creating ? '账号已创建。' : '已登录，记录已切换到该账号。');
    } catch (reason) {
      if (generation !== authGeneration) return;
      const target = document.getElementById('cloud-auth-error');
      if (target) target.textContent = reason.name === 'AbortError' ? '连接较慢，请稍后重试；本机记录仍保留。' : reason.message;
      else hooks.toast(reason.message || '暂时无法登录。');
    } finally {
      if (lease && lease !== heldLock) lease.release();
      if (issued) await request('logout', 'POST', undefined, issued).catch(() => {});
      if (button.isConnected) { button.disabled = false; button.textContent = creating ? '创建账号并继续' : '登录并同步'; }
    }
  }
  async function logout() {
    authGeneration++;
    const old = session; controller?.stop(); activate(null, read(accountStorageKey(null)), { revision: 0, dirty: false }); close();
    if (old) await request('logout', 'POST', undefined, old).catch(() => {});
    hooks.toast('已退出账号。该账号的待上传记录仍保留在本机。');
  }
  root.EnglishSync = {
    storageKey: key, pack,
    changed(value) { if (applying || !controller) return; controller.changed(value); clearTimeout(timer); timer = setTimeout(() => controller?.flush(), 900); },
    mount(appHooks) {
      hooks = appHooks; dialog = document.createElement('dialog'); dialog.className = 'sync-dialog'; dialog.setAttribute('aria-label', '学习账号'); document.body.appendChild(dialog);
      dialog.addEventListener('close', () => { dialog.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; }); if (choice) { const resolve = choice; choice = null; resolve('cancel'); } });
      dialog.addEventListener('cancel', () => { authGeneration++; });
      dialog.addEventListener('submit', event => { if (event.target.id === 'cloud-auth-form') { event.preventDefault(); signIn(event.target); } });
      document.addEventListener('click', async event => {
        const element = event.target.closest('[data-sync]'); if (!element) return; const action = element.dataset.sync;
        if (action === 'account') showAccount(); else if (action === 'close') { authGeneration++; close(); }
        else if (action === 'login-tab' || action === 'register-tab') { authMode = action === 'login-tab' ? 'login' : 'register'; showAuth(); }
        else if (action === 'export') hooks.export(); else if (action === 'logout') await logout();
        else if (action === 'sync-now') { close(); await controller?.pull(); } else if (action === 'show-conflict') showConflict();
        else if (action === 'conflict-cloud') { close(); await controller?.useCloud(); } else if (action === 'conflict-local') { close(); await controller?.useLocal(); }
        else if (action === 'migrate-cloud' || action === 'migrate-local') { const resolve = choice; choice = null; close(); resolve?.(action === 'migrate-cloud' ? 'cloud' : 'local'); }
      });
      updateStatus(status);
      if (rememberedSession) {
        const savedSession = rememberedSession, generation = ++authGeneration;
        reserveAccount(savedSession.user.id).then(lease => {
          if (generation !== authGeneration) { if (lease && lease !== heldLock) lease.release(); return; }
          if (!lease) { hooks.toast('此账号已在另一个标签页使用。本页可继续访客学习，或关闭另一页后登录。'); return; }
          const cached = read(accountStorageKey(savedSession.user.id)), meta = cached?.__cloudSync || { revision: 0, dirty: false };
          activate(savedSession, cached, meta, lease); controller.pull();
        }).catch(error => { if (generation === authGeneration) hooks.toast(error.message); });
      }
      window.addEventListener('online', () => controller?.pull());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') controller?.pull(); });
      setInterval(() => { if (navigator.onLine && document.visibilityState === 'visible') controller?.pull(); }, 45000);
    }
  };
})(globalThis);
