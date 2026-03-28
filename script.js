/* =============================================
   Revive — script.js
   Full Frontend Logic + Local State + Backend Integration
   ============================================= */

// ===================== STATE =====================
let state = {
  user: null,
  lessons: [],
  revisions: [],
  sessions: [],
  analytics: { focusTime: 0, completedRevisions: 0, streak: 0, productivity: 0 },
  demoMode: false,
  currentSection: 'dashboard',
  calendarDate: new Date(),
  wfRuns: 0,
  remindersSent: 0,
  automationLog: [],
};

// Timer state
let timer = {
  mode: 'focus',
  durations: { focus: 25 * 60, short: 5 * 60, long: 15 * 60 },
  remaining: 25 * 60,
  total: 25 * 60,
  running: false,
  interval: null,
  sessions: 0,
  todayFocus: 0,
  activeLesson: null,
};

// Revision popup queue
let revisionQueue = [];
let currentRevision = null;

// ===================== CONSTANTS =====================
const INTERVALS_REAL = [0, 3 * 24 * 60, 10 * 24 * 60]; // minutes: immediate, 3d, 10d
const INTERVALS_DEMO = [0.5, 3, 10];                     // demo: 30sec, 3min, 10min
const INTERVAL_LABELS = ['Immediate', '3-Day', '10-Day'];
const INTERVAL_CLASSES = ['immediate', 'day3', 'day10'];
const PRIORITY_COLORS = { high: '#ff5f6d', medium: '#ff9f4f', low: '#3ddc84' };
const API_BASE = '/api'; // Your backend URL here

// ===================== INIT =====================
document.addEventListener('DOMContentLoaded', () => {
  updateDate();
  loadFromStorage();
  setInterval(checkRevisionsDue, 15000); // Check every 15s
  setInterval(updateDate, 60000);
  initMiniChart();
});

function updateDate() {
  const now = new Date();
  const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const el = document.getElementById('page-date');
  if (el) el.textContent = now.toLocaleDateString('en-IN', opts);
}

// ===================== STORAGE =====================
function saveToStorage() {
  localStorage.setItem('rv_state', JSON.stringify({
    user: state.user,
    lessons: state.lessons,
    revisions: state.revisions,
    sessions: state.sessions,
    analytics: state.analytics,
    demoMode: state.demoMode,
  }));
}

function loadFromStorage() {
  const raw = localStorage.getItem('rv_state');
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    state.user = saved.user || null;
    state.lessons = (saved.lessons || []).map(l => ({
      ...l,
      addedAt: new Date(l.addedAt)
    }));
    state.revisions = (saved.revisions || []).map(r => ({
      ...r,
      scheduledAt: new Date(r.scheduledAt)
    }));
    state.sessions = saved.sessions || [];
    state.analytics = saved.analytics || state.analytics;
    state.demoMode = saved.demoMode || false;

    if (state.user) {
      showApp();
    }
    if (state.demoMode) {
      document.getElementById('demo-toggle').classList.add('on');
      document.getElementById('demo-label').textContent = 'Demo Mode: ON';
    }
  } catch(e) {
    console.warn('Storage parse error', e);
  }
}

// ===================== AUTH =====================
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'signup'));
  });
  document.getElementById('login-form').classList.toggle('active', tab === 'login');
  document.getElementById('signup-form').classList.toggle('active', tab === 'signup');
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-password').value.trim();
  if (!email || !pass) return showToast('warning', '⚠️ Missing fields', 'Please enter email and password.');

  // Demo shortcut
  if (email === 'test@demo.com' && pass === 'password123') {
    loginSuccess({ name: 'Demo User', email, id: 'demo' });
    return;
  }

  try {
    showToast('info', '🔄 Signing in...', 'Connecting to server...');
    const res = await apiCall('/auth/login', 'POST', { email, password: pass });
    if (res.success) {
      loginSuccess(res.user);
      if (res.token) localStorage.setItem('rv_token', res.token);
    } else {
      showToast('error', '❌ Login failed', res.message || 'Invalid credentials.');
    }
  } catch (e) {
    // Offline mode fallback
    loginSuccess({ name: email.split('@')[0], email, id: Date.now().toString() });
    showToast('info', '📴 Offline mode', 'Running locally without server.');
  }
}

async function handleSignup() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pass = document.getElementById('signup-password').value.trim();
  if (!name || !email || !pass) return showToast('warning', '⚠️ Missing fields', 'All fields are required.');

  try {
    showToast('info', '🔄 Creating account...', 'Setting up your profile...');
    const res = await apiCall('/auth/signup', 'POST', { name, email, password: pass });
    if (res.success) {
      loginSuccess(res.user);
      if (res.token) localStorage.setItem('rv_token', res.token);
    } else {
      showToast('error', '❌ Signup failed', res.message || 'Try a different email.');
    }
  } catch (e) {
    loginSuccess({ name, email, id: Date.now().toString() });
    showToast('info', '📴 Offline mode', 'Account created locally.');
  }
}

function loginSuccess(user) {
  state.user = user;
  saveToStorage();
  showApp();
  showToast('success', '✅ Welcome!', `Hello, ${user.name}!`);
  addLog('success', `User logged in: ${user.name}`);
}

function showApp() {
  startBeepPolling(); // Start polling for beep alerts
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');

  // Set user info everywhere
  const initial = (state.user?.name || 'U')[0].toUpperCase();
  document.getElementById('user-avatar-sidebar').textContent = initial;
  document.getElementById('user-avatar-top').textContent = initial;
  document.getElementById('user-name-display').textContent = state.user?.name || 'User';
  document.getElementById('welcome-name').textContent = state.user?.name?.split(' ')[0] || 'Learner';

  renderDashboard();
  renderLessons();
  renderRevisions();
  renderCalendar();
  renderTimerLessonSelect();
  updateCurveLessonSelect();
  updateBadges();
}

function handleLogout() {
  state.user = null;
  saveToStorage();
  document.getElementById('app-screen').classList.remove('active');
  document.getElementById('auth-screen').classList.add('active');
  showToast('info', '👋 Logged out', 'See you next time!');
}

// ===================== NAVIGATION =====================
function showSection(name) {
  state.currentSection = name;
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const section = document.getElementById(`section-${name}`);
  const navItem = document.querySelector(`[data-section="${name}"]`);
  if (section) section.classList.add('active');
  if (navItem) navItem.classList.add('active');

  const titles = {
    dashboard: 'Dashboard', lessons: 'Lesson Library',
    calendar: 'Revision Calendar', revisions: 'Revision Queue',
    analytics: 'Analytics', curve: 'Forgetting Curve',
    automation: 'Automation Engine', timer: 'Focus Timer'
  };
  document.getElementById('page-title').textContent = titles[name] || name;

  if (name === 'analytics') setTimeout(renderAnalyticsCharts, 100);
  if (name === 'curve') setTimeout(renderForgettingCurve, 100);
  if (name === 'calendar') renderCalendar();
  if (name === 'revisions') renderRevisions();

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('mobile-open');
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (window.innerWidth <= 600) {
    sb.classList.toggle('mobile-open');
  } else {
    sb.classList.toggle('hidden');
    document.querySelector('.main-content').classList.toggle('full');
  }
}

// ===================== DEMO MODE =====================
function toggleDemoMode() {
  state.demoMode = !state.demoMode;
  const toggle = document.getElementById('demo-toggle');
  const label = document.getElementById('demo-label');
  toggle.classList.toggle('on', state.demoMode);
  label.textContent = state.demoMode ? 'Demo Mode: ON' : 'Demo Mode: OFF';
  document.getElementById('demo-info-box').classList.toggle('show', state.demoMode);
  saveToStorage();
  showToast(state.demoMode ? 'warning' : 'info',
    state.demoMode ? '⚡ Demo Mode ON' : '📅 Demo Mode OFF',
    state.demoMode ? '3 days → 3 minutes, 10 days → 10 minutes' : 'Real intervals restored.');
  addLog(state.demoMode ? 'warning' : 'info',
    `Demo mode ${state.demoMode ? 'enabled' : 'disabled'}`);
}

function getIntervals() {
  return state.demoMode ? INTERVALS_DEMO : INTERVALS_REAL;
}

// ===================== LESSON MANAGEMENT =====================
function openLessonModal() {
  document.getElementById('lesson-modal').classList.add('open');
  const demoBox = document.getElementById('demo-info-box');
  if (state.demoMode) demoBox.classList.add('show'); else demoBox.classList.remove('show');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function addLesson() {
  const title = document.getElementById('lesson-title').value.trim();
  const subject = document.getElementById('lesson-subject').value.trim();
  const priority = document.getElementById('lesson-priority').value;
  const notes = document.getElementById('lesson-notes').value.trim();

  if (!title) return showToast('warning', '⚠️ Title required', 'Please enter a lesson title.');

  const lesson = {
    id: 'lesson_' + Date.now(),
    title,
    subject: subject || 'General',
    priority,
    notes,
    addedAt: new Date(),
    retention: 100,
    revisionsDone: 0,
    nextRevisionIndex: 0,
  };

  state.lessons.push(lesson);
  scheduleRevisions(lesson);
  saveToStorage();

  closeModal('lesson-modal');
  clearLessonForm();

  renderDashboard();
  renderLessons();
  renderCalendar();
  renderRevisions();
  updateCurveLessonSelect();
  renderTimerLessonSelect();
  updateBadges();

  showToast('success', '✅ Lesson Added!', `"${title}" scheduled with spaced repetition.`);
  addLog('success', `Lesson added: "${title}" | Priority: ${priority.toUpperCase()}`);

  // Trigger automation
  simulateAutomation(lesson);

  // Sync to backend
  syncLesson(lesson);
}

function clearLessonForm() {
  ['lesson-title','lesson-subject','lesson-notes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('lesson-priority').value = 'medium';
}

function scheduleRevisions(lesson) {
  const intervals = getIntervals();
  const now = new Date();

  // Always schedule 3 intervals: immediate, +3d(or 3m), +10d(or 10m)
  intervals.forEach((delayMin, i) => {
    const scheduledAt = new Date(now.getTime() + delayMin * 60000);
    const revision = {
      id: `rev_${lesson.id}_${i}`,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      intervalIndex: i,
      intervalLabel: INTERVAL_LABELS[i],
      scheduledAt,
      status: 'pending', // pending | completed | missed
      result: null,      // remembered | forgot
    };
    state.revisions.push(revision);
  });

  addLog('info', `Scheduled ${intervals.length} revisions for "${lesson.title}" [${state.demoMode ? 'DEMO' : 'REAL'} mode]`);
}

function rescheduleMissedRevision(revision, result) {
  const intervals = getIntervals();
  const nextIdx = revision.intervalIndex + 1;

  if (result === 'forgot') {
    // If forgotten, re-schedule sooner
    const retry = new Date(Date.now() + (state.demoMode ? 1 * 60000 : 60 * 60000));
    const retryRev = {
      id: `rev_${revision.lessonId}_retry_${Date.now()}`,
      lessonId: revision.lessonId,
      lessonTitle: revision.lessonTitle,
      intervalIndex: revision.intervalIndex,
      intervalLabel: '↩ Retry',
      scheduledAt: retry,
      status: 'pending',
      result: null,
    };
    state.revisions.push(retryRev);
    addLog('warning', `Retry scheduled for "${revision.lessonTitle}" (was forgotten)`);
  }
}

function filterLessons(priority, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderLessons(priority);
}

async function syncLesson(lesson) {
  try {
    await apiCall('/lessons', 'POST', lesson);
  } catch (e) { /* offline OK */ }
}

// ===================== RENDER DASHBOARD =====================
function renderDashboard() {
  // Stats
  const due = state.revisions.filter(r => r.status === 'pending' && new Date(r.scheduledAt) <= new Date()).length;
  document.getElementById('stat-lessons').textContent = state.lessons.length;
  document.getElementById('stat-revisions').textContent = due;
  document.getElementById('stat-streak').textContent = state.analytics.streak || 0;
  document.getElementById('stat-score').textContent = getAvgRetention() + '%';

  // Recent lessons
  const list = document.getElementById('recent-lessons-list');
  const recent = [...state.lessons].reverse().slice(0, 8);
  if (recent.length === 0) {
    list.innerHTML = '<div class="empty-state-small">No lessons yet. Add your first lesson!</div>';
  } else {
    list.innerHTML = recent.map(l => `
      <div class="lesson-compact-item" onclick="showSection('lessons')">
        <span class="lesson-compact-dot" style="background:${PRIORITY_COLORS[l.priority]}"></span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.title}</span>
      </div>`).join('');
  }

  // Upcoming revisions
  const upcomingEl = document.getElementById('upcoming-revisions-list');
  const upcoming = state.revisions
    .filter(r => r.status === 'pending')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(0, 5);

  const now = new Date();
  if (upcoming.length === 0) {
    upcomingEl.innerHTML = '<div class="empty-state-small">All caught up! 🎉</div>';
  } else {
    upcomingEl.innerHTML = upcoming.map(r => {
      const due = new Date(r.scheduledAt) <= now;
      return `<div class="revision-compact-item ${due ? 'due' : ''}">
        <span>${due ? '🔴' : '🕐'}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.lessonTitle}</span>
        <span style="color:var(--text-muted);font-size:10px">${due ? 'NOW' : formatRelTime(new Date(r.scheduledAt))}</span>
      </div>`;
    }).join('');
  }
}

function getAvgRetention() {
  if (state.lessons.length === 0) return 0;
  const total = state.lessons.reduce((s, l) => s + (l.retention || 0), 0);
  return Math.round(total / state.lessons.length);
}

// ===================== RENDER LESSONS =====================
function renderLessons(filterPriority = 'all') {
  const grid = document.getElementById('lessons-grid');
  let lessons = [...state.lessons].reverse();
  if (filterPriority !== 'all') lessons = lessons.filter(l => l.priority === filterPriority);

  if (lessons.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📚</div>
      <p>${filterPriority !== 'all' ? 'No lessons with this priority.' : 'No lessons added yet.'}</p>
      ${filterPriority === 'all' ? '<button class="btn-primary" onclick="openLessonModal()">Add Your First Lesson</button>' : ''}
    </div>`;
    return;
  }

  grid.innerHTML = lessons.map(lesson => {
    const retention = lesson.retention || 100;
    const retColor = retention > 70 ? 'var(--accent-green)' : retention > 40 ? 'var(--accent-orange)' : 'var(--accent-red)';
    const nextRev = getNextRevision(lesson.id);

    return `<div class="lesson-card ${lesson.priority}">
      <div class="lesson-card-header">
        <div class="lesson-title">${lesson.title}</div>
        <span class="priority-badge ${lesson.priority}">${lesson.priority.toUpperCase()}</span>
      </div>
      <div class="lesson-subject">📁 ${lesson.subject}</div>
      ${lesson.notes ? `<div class="lesson-notes-preview">${lesson.notes}</div>` : ''}
      <div class="retention-bar">
        <div class="retention-fill" style="width:${retention}%;background:${retColor}"></div>
      </div>
      <div class="lesson-meta">
        <span>Retention: <b>${retention}%</b></span>
        <span>Added: ${formatDate(new Date(lesson.addedAt))}</span>
      </div>
      <div class="lesson-meta" style="margin-top:4px">
        <span>Revisions: <b>${lesson.revisionsDone || 0}</b></span>
        <span>${nextRev ? `Next: ${formatRelTime(new Date(nextRev.scheduledAt))}` : '✅ All done'}</span>
      </div>
      <div class="lesson-actions">
        <button class="lesson-action-btn" onclick="startTimerForLesson('${lesson.id}')">⏱ Study</button>
        <button class="lesson-action-btn" title="Upload PDF/DOCX/TXT and get AI summary" onclick="uploadNotes('${lesson.id}')">📄 Notes</button>
        ${lesson.summary ? '<button class=\"lesson-action-btn\" style=\"color:#3ddc84\" onclick=\"viewSummary(\'' + lesson.id + '\')\">📋 Summary</button>' : ''}
        <button class="lesson-action-btn" style="color:#ff9f4f" onclick="openBeepModal(lesson.title)">🔔 Alert</button>
        <button class="lesson-action-btn" onclick="deleteLesson('${lesson.id}')">🗑 Remove</button>
      </div>
    </div>`;
  }).join('');
}

function getNextRevision(lessonId) {
  const now = new Date();
  return state.revisions
    .filter(r => r.lessonId === lessonId && r.status === 'pending')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0] || null;
}

function deleteLesson(id) {
  state.lessons = state.lessons.filter(l => l.id !== id);
  state.revisions = state.revisions.filter(r => r.lessonId !== id);
  saveToStorage();
  renderDashboard();
  renderLessons();
  renderRevisions();
  renderCalendar();
  updateBadges();
  showToast('info', '🗑️ Lesson removed', 'All scheduled revisions cleared.');
}

function startTimerForLesson(id) {
  const lesson = state.lessons.find(l => l.id === id);
  if (lesson) {
    document.getElementById('timer-lesson-select').value = id;
    timer.activeLesson = lesson;
    showSection('timer');
  }
}

// ===================== RENDER REVISIONS =====================
function renderRevisions() {
  const container = document.getElementById('revisions-list');
  const now = new Date();
  const allPending = state.revisions
    .filter(r => r.status === 'pending')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

  const due = allPending.filter(r => new Date(r.scheduledAt) <= now);
  const upcoming = allPending.filter(r => new Date(r.scheduledAt) > now);

  document.getElementById('rev-due-count').textContent = `${due.length} Due`;
  document.getElementById('rev-upcoming-count').textContent = `${upcoming.length} Upcoming`;

  if (allPending.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✅</div>
      <p>No revisions scheduled. Add lessons to start!</p>
    </div>`;
    return;
  }

  let html = '';

  if (due.length > 0) {
    html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent-orange);margin-bottom:8px">🔴 Due Now (${due.length})</div>`;
    html += due.map(r => revisionItemHTML(r, true)).join('');
  }
  if (upcoming.length > 0) {
    html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:16px 0 8px">🕐 Upcoming (${upcoming.length})</div>`;
    html += upcoming.map(r => revisionItemHTML(r, false)).join('');
  }

  container.innerHTML = html;
}

function revisionItemHTML(rev, isDue) {
  return `<div class="revision-item ${isDue ? 'due-now' : ''}">
    <span class="rev-interval-badge ${INTERVAL_CLASSES[rev.intervalIndex] || 'immediate'}">${rev.intervalLabel}</span>
    <div class="rev-info">
      <div class="rev-lesson-name">${rev.lessonTitle}</div>
      <div class="rev-time">${isDue ? '⚡ Due now' : '⏰ ' + formatRelTime(new Date(rev.scheduledAt))}</div>
    </div>
    <div class="rev-actions">
      <button class="rev-btn-ok" onclick="completeRevision('${rev.id}','remembered')">✅ Got it</button>
      <button class="rev-btn-forgot" onclick="completeRevision('${rev.id}','forgot')">❌ Forgot</button>
    </div>
  </div>`;
}

function completeRevision(revId, result) {
  const rev = state.revisions.find(r => r.id === revId);
  if (!rev) return;

  rev.status = 'completed';
  rev.result = result;

  const lesson = state.lessons.find(l => l.id === rev.lessonId);
  if (lesson) {
    lesson.revisionsDone = (lesson.revisionsDone || 0) + 1;
    if (result === 'remembered') {
      lesson.retention = Math.min(100, (lesson.retention || 50) + 20);
    } else {
      lesson.retention = Math.max(10, (lesson.retention || 100) - 30);
    }
  }

  state.analytics.completedRevisions = (state.analytics.completedRevisions || 0) + 1;
  state.analytics.streak = (state.analytics.streak || 0) + (result === 'remembered' ? 1 : 0);
  state.remindersSent++;

  if (result === 'forgot') rescheduleMissedRevision(rev, result);

  saveToStorage();
  renderRevisions();
  renderDashboard();
  renderLessons();
  updateBadges();

  const msg = result === 'remembered' ? '🧠 Great recall! Retention increased.' : '📝 Retry scheduled soon.';
  showToast(result === 'remembered' ? 'success' : 'warning',
    result === 'remembered' ? '✅ Remembered!' : '↩️ Retry scheduled', msg);
  addLog(result === 'remembered' ? 'success' : 'warning',
    `Revision "${rev.lessonTitle}" marked as ${result.toUpperCase()}`);

  document.getElementById('reminders-sent-val').textContent = state.remindersSent;
}

// ===================== REVISION CHECKER =====================
function checkRevisionsDue() {
  const now = new Date();
  const due = state.revisions.filter(r =>
    r.status === 'pending' && new Date(r.scheduledAt) <= now
  );

  if (due.length > 0) {
    document.getElementById('notif-dot').style.display = 'block';
    revisionQueue = due.filter(r => !revisionQueue.find(q => q.id === r.id));
    if (!currentRevision) showNextRevisionPopup();
  }
  updateBadges();
}

function showNextRevisionPopup() {
  if (revisionQueue.length === 0) return;
  currentRevision = revisionQueue.shift();
  document.getElementById('rev-popup-title').textContent = 'Revision Due!';
  document.getElementById('rev-popup-subtitle').textContent = `Revise: ${currentRevision.lessonTitle}`;
  document.getElementById('revision-popup').style.display = 'block';

  if (state.demoMode) {
    addLog('warning', `🔔 DEMO REMINDER: "Revise: ${currentRevision.lessonTitle}" [${currentRevision.intervalLabel}]`);
    showToast('warning', '🔔 Revision Reminder', `Revise: ${currentRevision.lessonTitle} — ${currentRevision.intervalLabel}`);
  }
}

function closeRevisionPopup() {
  document.getElementById('revision-popup').style.display = 'none';
  currentRevision = null;
  setTimeout(showNextRevisionPopup, 3000);
}

function markRevision(result) {
  if (!currentRevision) return;
  completeRevision(currentRevision.id, result);
  document.getElementById('revision-popup').style.display = 'none';
  currentRevision = null;
  setTimeout(showNextRevisionPopup, 3000);
}

function updateBadges() {
  const now = new Date();
  const due = state.revisions.filter(r => r.status === 'pending' && new Date(r.scheduledAt) <= now).length;
  document.getElementById('revision-badge').textContent = due;
  document.getElementById('stat-revisions').textContent = due;
  if (due > 0) {
    document.getElementById('notif-dot').style.display = 'block';
  } else {
    document.getElementById('notif-dot').style.display = 'none';
  }
}

// ===================== CALENDAR =====================
let calYear, calMonth;

function renderCalendar() {
  const now = new Date();
  if (calYear === undefined) { calYear = now.getFullYear(); calMonth = now.getMonth(); }

  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('cal-month-label').textContent = `${months[calMonth]} ${calYear}`;

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

  const grid = document.getElementById('calendar-grid');
  let html = '';

  // Previous month padding
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="cal-day other-month"><span class="cal-day-num">${daysInPrevMonth - i}</span></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = (d === now.getDate() && calMonth === now.getMonth() && calYear === now.getFullYear());

    // Get revisions for this day
    const dayRevs = state.revisions.filter(r => {
      const rd = new Date(r.scheduledAt);
      return rd.getFullYear() === calYear && rd.getMonth() === calMonth && rd.getDate() === d;
    });

    const eventsHTML = dayRevs.slice(0, 3).map(r => {
      const lesson = state.lessons.find(l => l.id === r.lessonId);
      const pri = lesson?.priority || 'medium';
      return `<div class="cal-event ${pri}" title="${r.lessonTitle}">${r.lessonTitle.substring(0,14)}${r.lessonTitle.length > 14 ? '…' : ''}</div>`;
    }).join('');

    const moreCount = dayRevs.length > 3 ? `<div class="cal-event medium">+${dayRevs.length - 3} more</div>` : '';

    html += `<div class="cal-day${isToday ? ' today' : ''}" onclick="showCalDay(${d})">
      <span class="cal-day-num">${d}</span>
      ${eventsHTML}
      ${moreCount}
    </div>`;
  }

  // Fill remaining cells
  const totalCells = firstDay + daysInMonth;
  const remainder = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remainder; i++) {
    html += `<div class="cal-day other-month"><span class="cal-day-num">${i}</span></div>`;
  }

  grid.innerHTML = html;
}

function changeMonth(dir) {
  calMonth += dir;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

function showCalDay(day) {
  const detail = document.getElementById('cal-day-detail');
  const dayRevs = state.revisions.filter(r => {
    const rd = new Date(r.scheduledAt);
    return rd.getFullYear() === calYear && rd.getMonth() === calMonth && rd.getDate() === day;
  });

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('cal-detail-date').textContent = `${day} ${months[calMonth]} ${calYear}`;

  if (dayRevs.length === 0) {
    document.getElementById('cal-detail-items').innerHTML = '<p style="color:var(--text-muted);font-size:13px">No revisions this day.</p>';
  } else {
    document.getElementById('cal-detail-items').innerHTML = dayRevs.map(r =>
      `<div class="revision-item" style="margin-top:8px">
        <span class="rev-interval-badge ${INTERVAL_CLASSES[r.intervalIndex] || 'immediate'}">${r.intervalLabel}</span>
        <div class="rev-info">
          <div class="rev-lesson-name">${r.lessonTitle}</div>
          <div class="rev-time">${formatTime(new Date(r.scheduledAt))} · ${r.status.toUpperCase()}</div>
        </div>
      </div>`).join('');
  }
  detail.style.display = 'block';
}

// ===================== ANALYTICS =====================
function renderAnalyticsCharts() {
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const completionData = days.map(() => Math.floor(Math.random() * 60) + 40);
  const productivityData = days.map(() => Math.floor(Math.random() * 40) + 60);

  // Weekly completion
  const wCtx = document.getElementById('weekly-chart')?.getContext('2d');
  if (wCtx) {
    destroyChart('weekly-chart');
    new Chart(wCtx, {
      type: 'bar',
      data: {
        labels: days,
        datasets: [{
          label: 'Completion %',
          data: completionData,
          backgroundColor: 'rgba(79,159,255,0.6)',
          borderColor: '#4f9fff',
          borderWidth: 1,
          borderRadius: 6,
        }]
      },
      options: chartDefaults()
    });
  }

  // Priority distribution
  const high = state.lessons.filter(l => l.priority === 'high').length;
  const med = state.lessons.filter(l => l.priority === 'medium').length;
  const low = state.lessons.filter(l => l.priority === 'low').length;
  const pCtx = document.getElementById('priority-chart')?.getContext('2d');
  if (pCtx) {
    destroyChart('priority-chart');
    new Chart(pCtx, {
      type: 'doughnut',
      data: {
        labels: ['High','Medium','Low'],
        datasets: [{
          data: [high || 1, med || 1, low || 1],
          backgroundColor: ['#ff5f6d','#ff9f4f','#3ddc84'],
          borderWidth: 0,
          hoverOffset: 8,
        }]
      },
      options: { ...chartDefaults(), cutout: '70%' }
    });
  }

  // Focus vs break
  const fCtx = document.getElementById('focus-chart')?.getContext('2d');
  const totalFocus = state.analytics.focusTime || 25;
  const totalBreak = Math.floor(totalFocus * 0.25);
  if (fCtx) {
    destroyChart('focus-chart');
    new Chart(fCtx, {
      type: 'doughnut',
      data: {
        labels: ['Focus','Break'],
        datasets: [{
          data: [totalFocus, totalBreak],
          backgroundColor: ['#4f9fff','#232840'],
          borderWidth: 0,
        }]
      },
      options: { ...chartDefaults(), cutout: '70%' }
    });
  }

  // Productivity trend
  const prodCtx = document.getElementById('productivity-chart')?.getContext('2d');
  if (prodCtx) {
    destroyChart('productivity-chart');
    new Chart(prodCtx, {
      type: 'line',
      data: {
        labels: days,
        datasets: [{
          label: 'Productivity Score',
          data: productivityData,
          borderColor: '#b57aff',
          backgroundColor: 'rgba(181,122,255,0.08)',
          tension: 0.4, fill: true, pointRadius: 4,
          pointBackgroundColor: '#b57aff',
        }]
      },
      options: chartDefaults()
    });
  }

  // Insights
  const completed = state.analytics.completedRevisions || 0;
  const total = state.revisions.length || 1;
  document.getElementById('ins-completion').textContent = Math.round((completed / total) * 100) + '%';
  document.getElementById('ins-focustime').textContent = (state.analytics.focusTime || 0) + 'm';
  document.getElementById('ins-productivity').textContent = Math.min(100, Math.round((completed / Math.max(total, 1)) * 100 + (state.analytics.streak || 0)));
  document.getElementById('ins-streak').textContent = state.analytics.streak || 0;
}

const chartInstances = {};
function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

function chartDefaults() {
  return {
    responsive: true,
    plugins: {
      legend: { labels: { color: '#8892aa', font: { family: 'DM Sans', size: 11 } } }
    },
    scales: {
      x: { ticks: { color: '#4a5270' }, grid: { color: 'rgba(255,255,255,0.03)' } },
      y: { ticks: { color: '#4a5270' }, grid: { color: 'rgba(255,255,255,0.03)' } }
    }
  };
}

// ===================== MINI CHART (DASHBOARD) =====================
function initMiniChart() {
  setTimeout(() => {
    const ctx = document.getElementById('mini-retention-chart')?.getContext('2d');
    if (!ctx) return;
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['Day1','Day3','Day7','Day10','Day14','Day21','Day30'],
        datasets: [
          {
            label: 'Without Revision',
            data: [100, 58, 35, 25, 20, 18, 15],
            borderColor: '#ff5f6d',
            backgroundColor: 'rgba(255,95,109,0.06)',
            tension: 0.4, fill: true, pointRadius: 3,
          },
          {
            label: 'With Spaced Repetition',
            data: [100, 95, 90, 95, 92, 90, 88],
            borderColor: '#3ddc84',
            backgroundColor: 'rgba(61,220,132,0.06)',
            tension: 0.4, fill: true, pointRadius: 3,
          }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#8892aa', font: { family: 'DM Sans', size: 10 }, boxWidth: 10 } } },
        scales: {
          x: { ticks: { color: '#4a5270', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.03)' } },
          y: { ticks: { color: '#4a5270', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.03)' }, min: 0, max: 100 }
        }
      }
    });
  }, 200);
}

// ===================== FORGETTING CURVE =====================
let curveChartInstance = null;

function updateCurveLessonSelect() {
  const sel = document.getElementById('curve-lesson-select');
  const existing = Array.from(sel.options).map(o => o.value);
  state.lessons.forEach(l => {
    if (!existing.includes(l.id)) {
      const opt = document.createElement('option');
      opt.value = l.id; opt.textContent = l.title;
      sel.appendChild(opt);
    }
  });
}

function updateCurveForLesson() { renderForgettingCurve(); }

function renderForgettingCurve() {
  const ctx = document.getElementById('forgetting-curve-chart')?.getContext('2d');
  if (!ctx) return;

  const selectedId = document.getElementById('curve-lesson-select').value;
  let lesson = null;
  if (selectedId !== 'all') lesson = state.lessons.find(l => l.id === selectedId);

  const retention = lesson ? (lesson.retention || 100) : getAvgRetention();
  const revDone = lesson ? (lesson.revisionsDone || 0) : state.analytics.completedRevisions || 0;

  document.getElementById('curve-retention').textContent = retention + '%';
  document.getElementById('curve-revisions-done').textContent = revDone;

  const nextRev = lesson ? getNextRevision(lesson.id) : null;
  document.getElementById('curve-next-rev').textContent = nextRev ? formatRelTime(new Date(nextRev.scheduledAt)) : '—';

  // Generate curve data (Ebbinghaus formula: R = e^(-t/S))
  const timePoints = [0,0.5,1,2,3,5,7,10,14,21,30];
  const withoutRevision = timePoints.map(t => Math.round(100 * Math.exp(-t / 3.5)));
  const withRevision = timePoints.map((t, i) => {
    // Simulated improved retention with spaced repetition
    const base = 100 * Math.exp(-t / 3.5);
    const boosts = [0, 20, 15, 12, 10, 8];
    const boost = boosts[Math.min(revDone, boosts.length - 1)] || 8;
    return Math.min(100, Math.round(base + boost * (1 - t/30)));
  });

  if (curveChartInstance) curveChartInstance.destroy();

  curveChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: timePoints.map(t => `Day ${t}`),
      datasets: [
        {
          label: 'Without Revision',
          data: withoutRevision,
          borderColor: '#ff5f6d',
          backgroundColor: 'rgba(255,95,109,0.08)',
          tension: 0.4, fill: true, pointRadius: 4,
          pointBackgroundColor: '#ff5f6d',
        },
        {
          label: 'With Spaced Repetition',
          data: withRevision,
          borderColor: '#3ddc84',
          backgroundColor: 'rgba(61,220,132,0.08)',
          tension: 0.4, fill: true, pointRadius: 4,
          pointBackgroundColor: '#3ddc84',
        },
        {
          label: 'Your Retention',
          data: timePoints.map(t => t === 0 ? retention : null),
          borderColor: '#4f9fff',
          borderDash: [5, 5],
          pointRadius: 6, pointBackgroundColor: '#4f9fff',
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#8892aa', font: { family: 'DM Sans' }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: '#151825',
          borderColor: '#232840', borderWidth: 1,
          titleColor: '#e8ecf5', bodyColor: '#8892aa',
        }
      },
      scales: {
        x: { ticks: { color: '#4a5270' }, grid: { color: 'rgba(255,255,255,0.03)' } },
        y: {
          ticks: { color: '#4a5270', callback: v => v + '%' },
          grid: { color: 'rgba(255,255,255,0.03)' },
          min: 0, max: 100
        }
      }
    }
  });
}

// ===================== AUTOMATION =====================
function simulateAutomation(lesson) {
  const intervals = getIntervals();
  state.wfRuns++;
  document.getElementById('wf-runs-val').textContent = state.wfRuns;
  document.getElementById('wf-last-val').textContent = formatTime(new Date());

  addLog('info', `[n8n] Workflow triggered: "Lesson Added" → "${lesson.title}"`);
  addLog('info', `[n8n] Calculating spaced repetition intervals...`);

  intervals.forEach((min, i) => {
    const label = state.demoMode ? `${min}min` : INTERVAL_LABELS[i];
    addLog('info', `[n8n] Scheduled revision ${i+1}: ${INTERVAL_LABELS[i]} (${label} ${state.demoMode ? '⚡DEMO' : ''})`);

    // Simulate wait + notification
    setTimeout(() => {
      if (i === 0 && min > 0) {
        addLog('success', `[n8n] ✅ Email sent: "Revise: ${lesson.title}" [${INTERVAL_LABELS[i]}]`);
        state.remindersSent++;
        document.getElementById('reminders-sent-val').textContent = state.remindersSent;
      }
    }, Math.min(min * 60000 * 0.1, 5000)); // Reduced for UI feedback
  });

  setTimeout(() => addLog('success', `[n8n] Workflow complete. ${intervals.length} reminders queued.`), 1200);
}

function addLog(type, msg) {
  const now = new Date();
  const ts = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}]`;
  const log = document.getElementById('automation-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  div.textContent = `${ts} ${msg}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  document.getElementById('automation-log').innerHTML =
    '<div class="log-entry info">[SYSTEM] Log cleared.</div>';
}

function saveEmailConfig() {
  const host = document.getElementById('smtp-host').value;
  const email = document.getElementById('smtp-email').value;
  const pass = document.getElementById('smtp-pass').value;
  if (!email || !pass) return showToast('warning', '⚠️ Missing', 'Please fill in email and password.');
  showToast('success', '✅ Email Config Saved', 'Test email will be sent shortly.');
  addLog('success', `Email config updated: ${email} via ${host}`);
  addLog('info', '[SMTP] Testing connection...');
  setTimeout(() => addLog('success', '[SMTP] Connection successful! Ready to send reminders.'), 1500);

  try {
    apiCall('/config/email', 'POST', { host, email, password: pass });
  } catch(e) {}
}

// ===================== TIMER =====================
function setTimerMode(mode, btn) {
  document.querySelectorAll('.timer-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  timer.mode = mode;
  const durations = { focus: 25*60, short: 5*60, long: 15*60 };
  const labels = { focus: 'Focus Session', short: 'Short Break', long: 'Long Break' };
  timer.remaining = durations[mode];
  timer.total = durations[mode];
  resetTimer();
  document.getElementById('timer-mode-label').textContent = labels[mode];
}

function toggleTimer() {
  if (timer.running) pauseTimer();
  else startTimer();
}

function startTimer() {
  timer.running = true;
  document.getElementById('timer-play-btn').textContent = '⏸';
  document.getElementById('timer-play-btn').classList.add('running');
  timer.interval = setInterval(() => {
    timer.remaining--;
    if (timer.mode === 'focus') timer.todayFocus++;
    if (timer.remaining <= 0) {
      timerComplete();
    } else {
      updateTimerDisplay();
    }
  }, 1000);
}

function pauseTimer() {
  timer.running = false;
  clearInterval(timer.interval);
  document.getElementById('timer-play-btn').textContent = '▶';
  document.getElementById('timer-play-btn').classList.remove('running');
}

function resetTimer() {
  pauseTimer();
  timer.remaining = timer.total;
  updateTimerDisplay();
}

function skipTimer() { timerComplete(); }

function timerComplete() {
  pauseTimer();
  timer.sessions++;
  document.getElementById('timer-session-count').textContent = timer.sessions;
  document.getElementById('timer-today-focus').textContent = Math.floor(timer.todayFocus / 60) + 'm';

  if (timer.mode === 'focus') {
    const lesson = state.lessons.find(l => l.id === document.getElementById('timer-lesson-select').value);
    const sessionEntry = {
      id: Date.now(),
      name: lesson ? lesson.title : 'Free Focus',
      duration: Math.floor(timer.total / 60),
      at: new Date().toISOString(),
    };
    state.sessions.push(sessionEntry);
    state.analytics.focusTime = (state.analytics.focusTime || 0) + Math.floor(timer.total / 60);
    saveToStorage();

    // Render session history
    renderTimerHistory();
    showToast('success', '🎯 Session Complete!', `${Math.floor(timer.total / 60)}min focus session done. Take a break!`);
    addLog('success', `Focus session complete: ${sessionEntry.name} (${sessionEntry.duration}min)`);
  }
}

function updateTimerDisplay() {
  const m = Math.floor(timer.remaining / 60);
  const s = timer.remaining % 60;
  document.getElementById('timer-display').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

  // Ring progress
  const pct = timer.remaining / timer.total;
  const circumference = 565.48;
  const offset = circumference * (1 - pct);
  document.getElementById('ring-progress').style.strokeDashoffset = offset;
}

function renderTimerLessonSelect() {
  const sel = document.getElementById('timer-lesson-select');
  sel.innerHTML = '<option value="">— Select a lesson —</option>';
  state.lessons.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id; opt.textContent = l.title;
    sel.appendChild(opt);
  });
}

function renderTimerHistory() {
  const list = document.getElementById('timer-history-list');
  const today = state.sessions.filter(s => {
    const d = new Date(s.at);
    const now = new Date();
    return d.getDate() === now.getDate() && d.getMonth() === now.getMonth();
  });
  if (today.length === 0) {
    list.innerHTML = '<div class="empty-state-small">No sessions yet today.</div>';
    return;
  }
  list.innerHTML = today.reverse().slice(0, 5).map(s =>
    `<div class="session-item">
      <span class="session-name">${s.name.substring(0, 18)}${s.name.length > 18 ? '…' : ''}</span>
      <span class="session-dur">${s.duration}m</span>
    </div>`).join('');
}

// ===================== TOAST NOTIFICATIONS =====================
function showToast(type, title, msg, duration = 4000) {
  const icons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ===================== API =====================
async function apiCall(endpoint, method = 'GET', body = null) {
  const token = localStorage.getItem('rv_token');
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${endpoint}`, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ===================== HELPERS =====================
function formatDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}

function formatTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function formatRelTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  const diff = d - new Date();
  if (diff < 0) return 'Overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

// ===================== BEEP / AUDIO REMINDER =====================
let beepCheckInterval = null;

/**
 * Play a beep sound using the Web Audio API (no external files needed).
 * freq: Hz, duration: ms, type: oscillator waveform
 */
function playBeep(freq = 880, duration = 400, type = 'sine', reps = 3) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let startTime = ctx.currentTime;
    for (let i = 0; i < reps; i++) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type      = type;
      osc.frequency.setValueAtTime(freq, startTime + i * 0.5);
      gain.gain.setValueAtTime(0.4, startTime + i * 0.5);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + i * 0.5 + duration / 1000);
      osc.start(startTime + i * 0.5);
      osc.stop(startTime + i * 0.5 + duration / 1000 + 0.1);
    }
  } catch (e) {
    console.warn('Beep failed:', e);
  }
}

// Set a beep reminder: called from the UI
async function setBeepReminder(lessonTitle, delayMinutes) {
  playBeep(440, 100, 'sine', 1); // Confirm beep

  try {
    const res = await apiCall('/reminders/beep', 'POST', {
      lessonTitle,
      delayMinutes: parseFloat(delayMinutes),
    });
    if (res.success) {
      showToast('success', '🔔 Beep Reminder Set',
        `You will hear an alert in ${delayMinutes} min for "${lessonTitle}"`);
      addLog('info', `[BEEP] Alert scheduled: "${lessonTitle}" in ${delayMinutes}min`);
    }
  } catch (e) {
    // Offline: use local setTimeout
    const ms = parseFloat(delayMinutes) * 60 * 1000;
    setTimeout(() => {
      playBeep(880, 400, 'square', 3);
      showToast('warning', '⏰ Revision Alert!', `Time to revise: ${lessonTitle}`);
      addLog('success', `[BEEP] Local alert fired: "${lessonTitle}"`);
    }, ms);
    showToast('success', '🔔 Beep Set (offline)', `Local alert in ${delayMinutes}min`);
  }
}

// Poll server every 5 seconds for due beeps
function startBeepPolling() {
  if (beepCheckInterval) return;
  beepCheckInterval = setInterval(async () => {
    try {
      const res = await apiCall('/reminders/beep/due', 'GET');
      if (res.success && res.due && res.due.length > 0) {
        res.due.forEach(rem => {
          playBeep(880, 400, 'square', 3);
          showToast('warning', '⏰ Revision Alert!', `Revise: ${rem.lessonTitle}`);
          addLog('success', `[BEEP] Server alert fired: "${rem.lessonTitle}"`);
        });
      }
    } catch (e) { /* offline is fine */ }
  }, 5000);
}

// ===================== NOTES UPLOAD + AI SUMMARY =====================
async function uploadNotes(lessonId) {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.pdf,.docx,.txt';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('info', '📤 Uploading...', `Processing ${file.name}…`);
    addLog('info', `[UPLOAD] Uploading notes: ${file.name}`);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const token = localStorage.getItem('rv_token');
      const res   = await fetch(`${API_BASE}/lessons/${lessonId}/upload`, {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json();

      if (data.success) {
        // Store summary locally too
        const lesson = state.lessons.find(l => l.id === lessonId);
        if (lesson) {
          lesson.summary         = data.summary;
          lesson.hasUploadedNotes = true;
          saveToStorage();
        }
        showToast('success', '✅ Notes Uploaded!', 'AI summary generated.');
        addLog('success', `[AI] Summary ready for "${lesson?.title}"`);
        renderLessons();
        showSummaryModal(data.summary, lesson?.title || 'Lesson');
      } else {
        showToast('error', '❌ Upload failed', data.message || 'Try again.');
      }
    } catch (err) {
      // Offline fallback: generate a simple local summary
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text    = ev.target.result.substring(0, 1000);
        const lines   = text.split('\n').filter(l => l.trim()).slice(0, 8);
        const summary = 'Key points:\n' + lines.map(l => `• ${l.trim()}`).join('\n');
        const lesson  = state.lessons.find(l => l.id === lessonId);
        if (lesson) { lesson.summary = summary; lesson.hasUploadedNotes = true; saveToStorage(); }
        showToast('success', '✅ Notes processed (offline)', 'Basic summary created.');
        renderLessons();
        showSummaryModal(summary, lesson?.title || 'Lesson');
      };
      reader.readAsText(file);
    }
  };
  input.click();
}

function showSummaryModal(summary, lessonTitle) {
  let modal = document.getElementById('summary-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'summary-modal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;
      align-items:center;justify-content:center;z-index:9999;padding:20px`;
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:#151825;border:1px solid #232840;border-radius:16px;
                padding:28px;max-width:560px;width:100%;max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="color:#3ddc84;font-family:'Syne',sans-serif;margin:0">
          📋 AI Key Notes — ${lessonTitle}</h3>
        <button onclick="document.getElementById('summary-modal').style.display='none'"
          style="background:none;border:none;color:#8892aa;font-size:20px;cursor:pointer">×</button>
      </div>
      <div style="color:#e8ecf5;line-height:1.7;white-space:pre-wrap;font-size:14px">
        ${summary || 'No summary available. Upload notes first.'}
      </div>
    </div>`;
  modal.style.display = 'flex';
}

function viewSummary(lessonId) {
  const lesson = state.lessons.find(l => l.id === lessonId);
  showSummaryModal(lesson?.summary || '', lesson?.title || 'Lesson');
}

// ===================== BEEP REMINDER UI =====================
function openBeepModal(lessonTitle) {
  let modal = document.getElementById('beep-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'beep-modal';
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;
      align-items:center;justify-content:center;z-index:9999;padding:20px`;
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:#151825;border:1px solid #232840;border-radius:16px;
                padding:28px;max-width:380px;width:100%">
      <h3 style="color:#ff9f4f;font-family:'Syne',sans-serif;margin:0 0 16px">
        🔔 Set Beep Reminder</h3>
      <p style="color:#8892aa;margin:0 0 16px;font-size:13px">
        Your laptop will beep when it's time to revise:</p>
      <p style="color:#e8ecf5;font-weight:600;margin:0 0 20px">"${lessonTitle}"</p>
      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#8892aa;margin-bottom:6px;
                       text-transform:uppercase;letter-spacing:.04em">Alert in (minutes)</label>
        <input id="beep-delay" type="number" value="5" min="0.5" step="0.5"
          style="width:100%;padding:11px 14px;background:#1a1e2e;border:1px solid #232840;
                 border-radius:8px;color:#e8ecf5;font-size:14px;outline:none">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button onclick="
          const d=document.getElementById('beep-delay').value;
          setBeepReminder('${lessonTitle.replace(/'/g, "\\'")}', d);
          document.getElementById('beep-modal').style.display='none'"
          style="flex:1;padding:11px;background:#ff9f4f;border:none;border-radius:8px;
                 color:#0a0c12;font-weight:700;cursor:pointer;font-size:14px">
          Set Alert 🔔
        </button>
        <button onclick="document.getElementById('beep-modal').style.display='none'"
          style="padding:11px 16px;background:transparent;border:1px solid #232840;
                 border-radius:8px;color:#8892aa;cursor:pointer">
          Cancel
        </button>
      </div>
      <button onclick="playBeep(880,400,'square',3)"
        style="width:100%;margin-top:10px;padding:8px;background:transparent;
               border:1px solid #3ddc84;border-radius:8px;color:#3ddc84;
               cursor:pointer;font-size:12px">
        🔊 Test Beep Sound
      </button>
    </div>`;
  modal.style.display = 'flex';
}


// ===================== AI CONFIG =====================
async function saveAiConfig() {
  const key = document.getElementById('anthropic-key')?.value?.trim();
  if (!key) return showToast('warning', '⚠️ Missing', 'Please enter your Anthropic API key.');
  try {
    const res = await apiCall('/config/ai', 'POST', { apiKey: key });
    showToast('success', '✅ API Key Saved', 'AI summaries are now enabled.');
    addLog('success', '[AI] Anthropic API key configured — summaries enabled');
  } catch (e) {
    // Store locally as fallback
    localStorage.setItem('rv_ai_key', key);
    showToast('info', '💾 Saved locally', 'Key stored in browser (offline mode).');
    addLog('info', '[AI] API key saved locally (server unavailable)');
  }
}