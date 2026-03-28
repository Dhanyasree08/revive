"""
Revive — app.py
Flask Backend: Auth, Lessons, Revisions, Analytics, Email, n8n Webhook
New features:
  - Notes upload (PDF/DOCX/TXT) per lesson
  - AI summary via Claude API (attached to email)
  - Beep/audio reminder scheduling endpoint
  - Email notifications with key-note summary attached
Database: database.json (flat-file)
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import json, os, hashlib, uuid, time, threading
from datetime import datetime, timedelta
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
import requests as http_requests

# Optional: for file reading
try:
    import PyPDF2
    HAS_PDF = True
except ImportError:
    HAS_PDF = False

try:
    from docx import Document as DocxDocument
    HAS_DOCX = True
except ImportError:
    HAS_DOCX = False

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

DB_FILE    = 'database.json'
UPLOAD_DIR = 'uploads'
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ── Anthropic API (set via env or /api/config) ────────────────────────────────
ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY', '')

# ===================== DATABASE =====================
def load_db():
    if not os.path.exists(DB_FILE):
        save_db({'users': {}, 'lessons': {}, 'revisions': {}, 'sessions': [],
                 'config': {}, 'automation_log': [], 'beep_reminders': []})
    with open(DB_FILE, 'r') as f:
        return json.load(f)

def save_db(db):
    with open(DB_FILE, 'w') as f:
        json.dump(db, f, indent=2, default=str)

def init_db():
    if not os.path.exists(DB_FILE):
        save_db({'users': {}, 'lessons': {}, 'revisions': {}, 'sessions': [],
                 'config': {}, 'automation_log': [
                     {'ts': datetime.now().isoformat(), 'msg': '[SYSTEM] Revive database initialized.'}
                 ], 'beep_reminders': []})

# ===================== AUTH HELPERS =====================
def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def generate_token(user_id):
    raw = f"{user_id}:{time.time()}:{uuid.uuid4()}"
    return hashlib.sha256(raw.encode()).hexdigest()

def get_user_from_token(token):
    db = load_db()
    for uid, user in db['users'].items():
        if user.get('token') == token:
            return user
    return None

def auth_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        user = get_user_from_token(token)
        if not user:
            return jsonify({'success': False, 'message': 'Unauthorized'}), 401
        request.user = user
        return f(*args, **kwargs)
    return decorated

# ===================== STATIC FILES =====================
@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory('.', filename)

# ===================== AUTH ROUTES =====================
@app.route('/api/auth/signup', methods=['POST'])
def signup():
    data = request.json or {}
    name     = data.get('name', '').strip()
    email    = data.get('email', '').strip().lower()
    password = data.get('password', '').strip()

    if not all([name, email, password]):
        return jsonify({'success': False, 'message': 'All fields required'}), 400

    db = load_db()
    for uid, user in db['users'].items():
        if user.get('email') == email:
            return jsonify({'success': False, 'message': 'Email already registered'}), 409

    user_id = str(uuid.uuid4())
    token   = generate_token(user_id)

    db['users'][user_id] = {
        'id': user_id, 'name': name, 'email': email,
        'password': hash_password(password), 'token': token,
        'created_at': datetime.now().isoformat(), 'streak': 0, 'focusTime': 0,
    }
    save_db(db)
    return jsonify({'success': True, 'token': token,
                    'user': {'id': user_id, 'name': name, 'email': email}})

@app.route('/api/auth/login', methods=['POST'])
def login():
    data     = request.json or {}
    email    = data.get('email', '').strip().lower()
    password = data.get('password', '').strip()

    db = load_db()
    for uid, user in db['users'].items():
        if user.get('email') == email and user.get('password') == hash_password(password):
            token = generate_token(uid)
            db['users'][uid]['token']      = token
            db['users'][uid]['last_login'] = datetime.now().isoformat()
            save_db(db)
            return jsonify({'success': True, 'token': token,
                            'user': {'id': uid, 'name': user['name'], 'email': user['email']}})
    return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

@app.route('/api/auth/me', methods=['GET'])
@auth_required
def get_me():
    return jsonify({'success': True, 'user': {
        'id': request.user['id'], 'name': request.user['name'], 'email': request.user['email'],
    }})

# ===================== LESSON ROUTES =====================
@app.route('/api/lessons', methods=['GET'])
@auth_required
def get_lessons():
    db = load_db()
    user_id = request.user['id']
    lessons = [l for l in db['lessons'].values() if l.get('userId') == user_id]
    lessons.sort(key=lambda l: l.get('addedAt', ''), reverse=True)
    return jsonify({'success': True, 'lessons': lessons})

@app.route('/api/lessons', methods=['POST'])
@auth_required
def add_lesson():
    data    = request.json or {}
    db      = load_db()
    user_id = request.user['id']
    demo_mode = data.get('demoMode', False)

    lesson_id = data.get('id') or str(uuid.uuid4())

    lesson = {
        'id':              lesson_id,
        'userId':          user_id,
        'title':           data.get('title', '').strip(),
        'subject':         data.get('subject', 'General').strip(),
        'priority':        data.get('priority', 'medium'),
        'notes':           data.get('notes', ''),
        'addedAt':         datetime.now().isoformat(),
        'retention':       100,
        'revisionsDone':   0,
        'nextRevisionIndex': 0,
        'uploadedFileId':  data.get('uploadedFileId'),    # NEW
        'summary':         data.get('summary', ''),        # NEW: AI summary
    }

    if not lesson['title']:
        return jsonify({'success': False, 'message': 'Title required'}), 400

    db['lessons'][lesson_id] = lesson

    revisions = schedule_revisions(lesson_id, lesson['title'], user_id, demo_mode)
    for rev in revisions:
        db['revisions'][rev['id']] = rev

    save_db(db)

    # Send lesson added email (with summary if available) in background
    email_cfg = db.get('config', {}).get('email')
    if email_cfg:
        summary = lesson.get('summary', '')
        threading.Thread(
            target=send_lesson_email,
            args=(email_cfg, request.user['email'], lesson['title'], summary)
        ).start()

    log_automation(db, f"Lesson added: {lesson['title']} | {len(revisions)} revisions scheduled")
    return jsonify({'success': True, 'lesson': lesson, 'revisions': revisions})

@app.route('/api/lessons/<lesson_id>', methods=['DELETE'])
@auth_required
def delete_lesson(lesson_id):
    db = load_db()
    user_id = request.user['id']
    if lesson_id in db['lessons'] and db['lessons'][lesson_id]['userId'] == user_id:
        del db['lessons'][lesson_id]
        to_del = [rid for rid, r in db['revisions'].items() if r['lessonId'] == lesson_id]
        for rid in to_del:
            del db['revisions'][rid]
        save_db(db)
        return jsonify({'success': True})
    return jsonify({'success': False, 'message': 'Not found'}), 404

# ===================== NOTES UPLOAD + AI SUMMARY =====================
@app.route('/api/lessons/<lesson_id>/upload', methods=['POST'])
@auth_required
def upload_notes(lesson_id):
    """Upload a PDF/DOCX/TXT file for a lesson and generate an AI summary."""
    db = load_db()
    if lesson_id not in db['lessons'] or db['lessons'][lesson_id]['userId'] != request.user['id']:
        return jsonify({'success': False, 'message': 'Lesson not found'}), 404

    if 'file' not in request.files:
        return jsonify({'success': False, 'message': 'No file provided'}), 400

    f        = request.files['file']
    ext      = os.path.splitext(f.filename)[1].lower()
    file_id  = str(uuid.uuid4())
    filename = f"{file_id}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    f.save(filepath)

    # Extract text from the uploaded file
    raw_text = extract_text(filepath, ext)

    # Generate AI summary via Claude API
    api_key  = db.get('config', {}).get('anthropic_key') or ANTHROPIC_API_KEY
    summary  = generate_summary(raw_text, db['lessons'][lesson_id]['title'], api_key)

    # Save file info and summary back to lesson
    db['lessons'][lesson_id]['uploadedFileId']   = file_id
    db['lessons'][lesson_id]['uploadedFileName']  = f.filename
    db['lessons'][lesson_id]['uploadedFilePath']  = filepath
    db['lessons'][lesson_id]['rawTextPreview']    = raw_text[:500]
    db['lessons'][lesson_id]['summary']           = summary
    save_db(db)

    log_automation(db, f"[UPLOAD] Notes uploaded for: {db['lessons'][lesson_id]['title']}")
    log_automation(db, f"[AI] Summary generated ({len(summary)} chars)")
    save_db(db)

    return jsonify({'success': True, 'summary': summary, 'fileId': file_id})

@app.route('/api/lessons/<lesson_id>/summary', methods=['GET'])
@auth_required
def get_summary(lesson_id):
    db = load_db()
    if lesson_id not in db['lessons'] or db['lessons'][lesson_id]['userId'] != request.user['id']:
        return jsonify({'success': False, 'message': 'Lesson not found'}), 404
    return jsonify({'success': True, 'summary': db['lessons'][lesson_id].get('summary', '')})

# ── File text extractor ───────────────────────────────────────────────────────
def extract_text(filepath, ext):
    try:
        if ext == '.txt':
            with open(filepath, 'r', errors='ignore') as f:
                return f.read()
        elif ext == '.pdf' and HAS_PDF:
            reader = PyPDF2.PdfReader(filepath)
            return '\n'.join(p.extract_text() or '' for p in reader.pages)
        elif ext in ('.docx',) and HAS_DOCX:
            doc = DocxDocument(filepath)
            return '\n'.join(p.text for p in doc.paragraphs)
        else:
            # Fallback: treat as text
            with open(filepath, 'r', errors='ignore') as f:
                return f.read()
    except Exception as e:
        print(f"Text extraction error: {e}")
        return ''

# ── AI summary via Claude API ─────────────────────────────────────────────────
def generate_summary(text, lesson_title, api_key):
    """Call Claude claude-sonnet-4-20250514 to generate key bullet-point notes."""
    if not api_key or not text.strip():
        # Fallback: simple truncation
        return f"[Summary not available — upload notes and set Anthropic API key]\n\n{text[:400]}…"

    prompt = f"""You are a study assistant. The student uploaded notes for a lesson titled "{lesson_title}".

Generate a concise revision summary with:
1. A 2-sentence overview
2. 5-8 key bullet points (the most important facts/concepts)
3. One "remember this" tip

Keep it brief and scannable. Student will read this right before revising.

Notes content:
{text[:4000]}"""

    try:
        resp = http_requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={
                'x-api-key': api_key,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            json={
                'model': 'claude-sonnet-4-20250514',
                'max_tokens': 600,
                'messages': [{'role': 'user', 'content': prompt}],
            },
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()['content'][0]['text']
    except Exception as e:
        print(f"AI summary error: {e}")
        # Simple fallback summary
        lines = [l.strip() for l in text.split('\n') if l.strip()][:8]
        return f"Key points from {lesson_title}:\n\n" + '\n'.join(f"• {l}" for l in lines)

# ===================== BEEP / AUDIO REMINDER =====================
@app.route('/api/reminders/beep', methods=['POST'])
@auth_required
def schedule_beep():
    """
    Schedule a beep sound reminder at a given time.
    Body: { lessonTitle, scheduledAt (ISO string or 'now'), delayMinutes }
    The client JS polls /api/reminders/beep/due to play the sound.
    """
    data         = request.json or {}
    lesson_title = data.get('lessonTitle', 'Revision')
    delay_min    = float(data.get('delayMinutes', 0))
    scheduled_at = data.get('scheduledAt')

    if not scheduled_at:
        scheduled_at = (datetime.now() + timedelta(minutes=delay_min)).isoformat()

    db = load_db()
    if 'beep_reminders' not in db:
        db['beep_reminders'] = []

    reminder = {
        'id':           str(uuid.uuid4()),
        'userId':       request.user['id'],
        'lessonTitle':  lesson_title,
        'scheduledAt':  scheduled_at,
        'triggered':    False,
    }
    db['beep_reminders'].append(reminder)
    save_db(db)
    log_automation(db, f"[BEEP] Scheduled alert for: {lesson_title} at {scheduled_at}")
    save_db(db)
    return jsonify({'success': True, 'reminder': reminder})

@app.route('/api/reminders/beep/due', methods=['GET'])
@auth_required
def get_due_beeps():
    """
    Frontend polls this every few seconds. Returns any un-triggered beeps that are due.
    Marks them as triggered so they don't repeat.
    """
    db = load_db()
    user_id = request.user['id']
    now = datetime.now().isoformat()
    due = []

    for rem in db.get('beep_reminders', []):
        if (rem.get('userId') == user_id
                and not rem.get('triggered')
                and rem.get('scheduledAt', '') <= now):
            rem['triggered'] = True
            due.append(rem)

    if due:
        save_db(db)

    return jsonify({'success': True, 'due': due})

@app.route('/api/reminders/beep', methods=['GET'])
@auth_required
def list_beeps():
    db = load_db()
    user_id = request.user['id']
    reminders = [r for r in db.get('beep_reminders', []) if r.get('userId') == user_id]
    return jsonify({'success': True, 'reminders': reminders})

# ===================== REVISION ROUTES =====================
@app.route('/api/revisions', methods=['GET'])
@auth_required
def get_revisions():
    db = load_db()
    user_id = request.user['id']
    revisions = [r for r in db['revisions'].values() if r.get('userId') == user_id]
    revisions.sort(key=lambda r: r.get('scheduledAt', ''))
    return jsonify({'success': True, 'revisions': revisions})

@app.route('/api/revisions/due', methods=['GET'])
@auth_required
def get_due_revisions():
    db = load_db()
    user_id = request.user['id']
    now = datetime.now().isoformat()
    due = [r for r in db['revisions'].values()
           if r.get('userId') == user_id
           and r.get('status') == 'pending'
           and r.get('scheduledAt', '') <= now]
    return jsonify({'success': True, 'revisions': due, 'count': len(due)})

@app.route('/api/revisions/<rev_id>/complete', methods=['POST'])
@auth_required
def complete_revision(rev_id):
    data   = request.json or {}
    result = data.get('result', 'remembered')
    db     = load_db()

    if rev_id not in db['revisions']:
        return jsonify({'success': False, 'message': 'Revision not found'}), 404

    rev            = db['revisions'][rev_id]
    rev['status']  = 'completed'
    rev['result']  = result
    rev['completedAt'] = datetime.now().isoformat()

    lesson_id = rev.get('lessonId')
    if lesson_id and lesson_id in db['lessons']:
        lesson = db['lessons'][lesson_id]
        if result == 'remembered':
            lesson['retention'] = min(100, lesson.get('retention', 50) + 20)
        else:
            lesson['retention'] = max(10, lesson.get('retention', 100) - 30)
        lesson['revisionsDone'] = lesson.get('revisionsDone', 0) + 1

    if result == 'forgot':
        demo_mode   = data.get('demoMode', False)
        retry_delay = 1 if demo_mode else 60
        retry_rev = {
            'id':            f"rev_retry_{rev_id}_{int(time.time())}",
            'lessonId':      rev['lessonId'],
            'lessonTitle':   rev['lessonTitle'],
            'userId':        rev['userId'],
            'intervalIndex': rev['intervalIndex'],
            'intervalLabel': '↩ Retry',
            'scheduledAt':   (datetime.now() + timedelta(minutes=retry_delay)).isoformat(),
            'status':        'pending',
            'result':        None,
        }
        db['revisions'][retry_rev['id']] = retry_rev

    save_db(db)
    return jsonify({'success': True, 'result': result})

# ===================== ANALYTICS =====================
@app.route('/api/analytics', methods=['GET'])
@auth_required
def get_analytics():
    db = load_db()
    user_id = request.user['id']

    lessons   = [l for l in db['lessons'].values()   if l.get('userId') == user_id]
    revisions = [r for r in db['revisions'].values()  if r.get('userId') == user_id]
    sessions  = [s for s in db.get('sessions', [])   if s.get('userId') == user_id]

    completed_revs = [r for r in revisions if r.get('status') == 'completed']
    remembered     = [r for r in completed_revs if r.get('result') == 'remembered']

    total_focus    = sum(s.get('duration', 0) for s in sessions)
    avg_retention  = (sum(l.get('retention', 0) for l in lessons) / len(lessons)) if lessons else 0
    completion_rate= (len(completed_revs) / len(revisions) * 100) if revisions else 0
    accuracy       = (len(remembered) / len(completed_revs) * 100) if completed_revs else 0

    return jsonify({'success': True, 'analytics': {
        'totalLessons':       len(lessons),
        'totalRevisions':     len(revisions),
        'completedRevisions': len(completed_revs),
        'completionRate':     round(completion_rate, 1),
        'accuracy':           round(accuracy, 1),
        'avgRetention':       round(avg_retention, 1),
        'totalFocusMinutes':  total_focus,
        'productivityScore':  round((completion_rate + accuracy) / 2),
    }})

# ===================== SESSIONS =====================
@app.route('/api/sessions', methods=['POST'])
@auth_required
def add_session():
    data = request.json or {}
    db   = load_db()
    session = {
        'id':           str(uuid.uuid4()),
        'userId':       request.user['id'],
        'lessonId':     data.get('lessonId'),
        'lessonTitle':  data.get('lessonTitle', 'Free Focus'),
        'duration':     data.get('duration', 25),
        'at':           datetime.now().isoformat(),
    }
    if 'sessions' not in db:
        db['sessions'] = []
    db['sessions'].append(session)
    save_db(db)
    return jsonify({'success': True, 'session': session})

# ===================== CONFIG =====================
@app.route('/api/config/email', methods=['POST'])
@auth_required
def save_email_config():
    data = request.json or {}
    db   = load_db()
    if 'config' not in db:
        db['config'] = {}
    db['config']['email'] = {
        'host':     data.get('host', 'smtp.gmail.com'),
        'port':     587,
        'email':    data.get('email', ''),
        'password': data.get('password', ''),
    }
    save_db(db)
    cfg = db['config']['email']
    try:
        send_test_email(cfg)
        return jsonify({'success': True, 'message': 'Config saved. Test email sent!'})
    except Exception as e:
        return jsonify({'success': True, 'message': f'Config saved. Email test failed: {str(e)}'})

@app.route('/api/config/ai', methods=['POST'])
@auth_required
def save_ai_config():
    """Save Anthropic API key for AI summaries."""
    data = request.json or {}
    db   = load_db()
    if 'config' not in db:
        db['config'] = {}
    db['config']['anthropic_key'] = data.get('apiKey', '').strip()
    save_db(db)
    return jsonify({'success': True, 'message': 'Anthropic API key saved.'})

# ===================== n8n WEBHOOK =====================
@app.route('/api/webhook/n8n', methods=['POST'])
def n8n_webhook():
    data  = request.json or {}
    event = data.get('event')
    db    = load_db()

    if event == 'lesson_added':
        log_automation(db, f"[n8n webhook] Lesson added: {data.get('lessonTitle')}")
    elif event == 'revision_due':
        log_automation(db, f"[n8n webhook] Revision due: {data.get('lessonTitle')}")
    elif event == 'reminder_sent':
        log_automation(db, f"[n8n webhook] Reminder sent: {data.get('lessonTitle')}")

    save_db(db)
    return jsonify({'success': True, 'received': event})

@app.route('/api/automation/log', methods=['GET'])
@auth_required
def get_automation_log():
    db = load_db()
    return jsonify({'success': True, 'log': db.get('automation_log', [])[-50:]})

# ===================== EMAIL HELPERS =====================
def build_summary_html(lesson_title, summary):
    """Build the key-notes section to embed in email HTML."""
    if not summary:
        return ''
    lines = summary.strip().split('\n')
    items = ''.join(
        f'<li style="color:#e8ecf5;margin:4px 0">{l}</li>'
        for l in lines if l.strip()
    )
    return f"""
    <div style="background:#0d1f0d;border:1px solid rgba(61,220,132,0.3);
                border-radius:8px;padding:16px;margin:16px 0">
      <p style="color:#3ddc84;font-weight:600;margin:0 0 8px">
        📋 AI-Generated Key Notes — {lesson_title}
      </p>
      <ul style="margin:0;padding-left:20px">{items}</ul>
    </div>"""

def send_lesson_email(cfg, to_email, lesson_title, summary=''):
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = f'🌿 Revive: Lesson Added — {lesson_title}'
        msg['From']    = cfg['email']
        msg['To']      = to_email

        summary_section = build_summary_html(lesson_title, summary)

        html = f"""
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;
                    background:#0a0c12;color:#e8ecf5;padding:32px;border-radius:12px">
          <h2 style="color:#4f9fff">🌿 Lesson Scheduled — Revive</h2>
          <p style="color:#8892aa">Your lesson
            <strong style="color:#e8ecf5">{lesson_title}</strong>
            has been added to Revive.</p>
          <div style="background:#151825;border:1px solid #232840;
                      border-radius:8px;padding:16px;margin:20px 0">
            <p style="color:#8892aa;margin:0 0 8px">Revision Schedule:</p>
            <ul style="color:#e8ecf5;margin:0;padding-left:20px">
              <li>✅ Immediate review</li>
              <li>📅 3-day revision</li>
              <li>📆 10-day revision</li>
            </ul>
          </div>
          {summary_section}
          <p style="color:#4a5270;font-size:12px;margin-top:24px">
            Powered by Ebbinghaus Spaced Repetition | Revive</p>
        </div>"""

        msg.attach(MIMEText(html, 'html'))
        _smtp_send(cfg, msg)
    except Exception as e:
        print(f"Email error (lesson): {e}")

def send_revision_email(cfg, to_email, lesson_title, interval_label, summary=''):
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = f'🔔 Revive: Revise — {lesson_title} [{interval_label}]'
        msg['From']    = cfg['email']
        msg['To']      = to_email

        summary_section = build_summary_html(lesson_title, summary)

        html = f"""
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;
                    background:#0a0c12;color:#e8ecf5;padding:32px;border-radius:12px">
          <h2 style="color:#ff9f4f">🔔 Revision Reminder — Revive</h2>
          <p style="color:#8892aa">It's time to revise:</p>
          <div style="background:#1a1600;border:1px solid rgba(255,159,79,0.3);
                      border-radius:8px;padding:20px;margin:16px 0;text-align:center">
            <h3 style="color:#ff9f4f;margin:0 0 8px">{lesson_title}</h3>
            <span style="background:rgba(255,159,79,0.2);color:#ff9f4f;
                         padding:4px 12px;border-radius:20px;font-size:12px">
              {interval_label} Review</span>
          </div>
          {summary_section}
          <p style="color:#8892aa;font-size:13px">
            Open Revive to complete your revision and track your retention score.</p>
          <p style="color:#4a5270;font-size:11px;margin-top:24px">
            Based on Ebbinghaus Forgetting Curve | Revive</p>
        </div>"""

        msg.attach(MIMEText(html, 'html'))
        _smtp_send(cfg, msg)
        print(f"Revision email sent to {to_email}: {lesson_title}")
    except Exception as e:
        print(f"Email error (revision): {e}")

def send_test_email(cfg):
    msg = MIMEText('<h2 style="color:#3ddc84">Revive email is working! 🎉</h2>', 'html')
    msg['Subject'] = '✅ Revive Email Test'
    msg['From']    = cfg['email']
    msg['To']      = cfg['email']
    _smtp_send(cfg, msg)

def _smtp_send(cfg, msg):
    server = smtplib.SMTP(cfg['host'], cfg.get('port', 587))
    server.starttls()
    server.login(cfg['email'], cfg['password'])
    server.send_message(msg)
    server.quit()

# ===================== HELPERS =====================
def schedule_revisions(lesson_id, lesson_title, user_id, demo_mode=False):
    intervals_real = [0, 3 * 24 * 60, 10 * 24 * 60]
    intervals_demo = [0.5, 3, 10]
    labels         = ['Immediate', '3-Day', '10-Day']
    intervals      = intervals_demo if demo_mode else intervals_real

    now       = datetime.now()
    revisions = []

    for i, delay_min in enumerate(intervals):
        scheduled = now + timedelta(minutes=delay_min)
        rev = {
            'id':            f"rev_{lesson_id}_{i}_{int(time.time())}",
            'lessonId':      lesson_id,
            'lessonTitle':   lesson_title,
            'userId':        user_id,
            'intervalIndex': i,
            'intervalLabel': labels[i],
            'scheduledAt':   scheduled.isoformat(),
            'status':        'pending',
            'result':        None,
            'demoMode':      demo_mode,
        }
        revisions.append(rev)
    return revisions

def log_automation(db, message):
    if 'automation_log' not in db:
        db['automation_log'] = []
    db['automation_log'].append({'ts': datetime.now().isoformat(), 'msg': message})

# ===================== BACKGROUND SCHEDULER =====================
def revision_checker():
    """Checks for due revisions every 30s and sends email reminders."""
    while True:
        try:
            db  = load_db()
            now = datetime.now().isoformat()
            cfg = db.get('config', {}).get('email')

            for rev_id, rev in list(db['revisions'].items()):
                if rev.get('status') == 'pending' and rev.get('scheduledAt', '') <= now:
                    if not rev.get('notified'):
                        db['revisions'][rev_id]['notified'] = True
                        log_automation(db, f"[AUTO] Revision due: {rev['lessonTitle']} [{rev['intervalLabel']}]")

                        if cfg:
                            user = db['users'].get(rev.get('userId', ''))
                            if user:
                                # Fetch lesson summary for email
                                lesson  = db['lessons'].get(rev.get('lessonId', ''), {})
                                summary = lesson.get('summary', '')
                                threading.Thread(
                                    target=send_revision_email,
                                    args=(cfg, user['email'], rev['lessonTitle'],
                                          rev['intervalLabel'], summary)
                                ).start()
                                log_automation(db, f"[EMAIL] Sent: Revise: {rev['lessonTitle']}")

            save_db(db)
        except Exception as e:
            print(f"Scheduler error: {e}")
        time.sleep(30)

# ===================== n8n WORKFLOW JSON =====================
@app.route('/api/n8n/workflow', methods=['GET'])
def get_n8n_workflow():
    workflow = {
        "name": "Revive - Spaced Repetition Automation",
        "nodes": [
            {
                "parameters": {"path": "/lesson-added", "httpMethod": "POST"},
                "name": "Webhook - Lesson Added",
                "type": "n8n-nodes-base.webhook",
                "position": [250, 300]
            },
            {
                "parameters": {
                    "url": "http://localhost:5000/api/lessons",
                    "method": "POST",
                    "bodyParametersUi": {"parameter": [
                        {"name": "title",    "value": "={{$json.lessonTitle}}"},
                        {"name": "demoMode", "value": "={{$json.demoMode}}"}
                    ]}
                },
                "name": "HTTP - Store Lesson",
                "type": "n8n-nodes-base.httpRequest",
                "position": [450, 300]
            },
            {
                "parameters": {"amount": 3, "unit": "minutes"},
                "name": "Wait - 3 min (3 days)",
                "type": "n8n-nodes-base.wait",
                "position": [650, 300]
            },
            {
                "parameters": {
                    "fromEmail": "=YOUR_EMAIL",
                    "toEmail":   "={{$json.userEmail}}",
                    "subject":   "=Revise: {{$json.lessonTitle}} - 3-Day Review",
                    "text":      "=Time to revise: {{$json.lessonTitle}}. Open Revive to complete your review."
                },
                "name": "Email - 3 Day Reminder",
                "type": "n8n-nodes-base.emailSend",
                "position": [850, 300]
            }
        ],
        "connections": {
            "Webhook - Lesson Added": {"main": [[{"node": "HTTP - Store Lesson"}]]},
            "HTTP - Store Lesson":    {"main": [[{"node": "Wait - 3 min (3 days)"}]]},
            "Wait - 3 min (3 days)": {"main": [[{"node": "Email - 3 Day Reminder"}]]}
        }
    }
    return jsonify(workflow)

# ===================== MAIN =====================
if __name__ == '__main__':
    init_db()
    checker = threading.Thread(target=revision_checker, daemon=True)
    checker.start()
    print("🌿 Revive server starting on port 5000...")
    print("📧 Email reminders: Configure via /api/config/email")
    print("🤖 AI Summaries:    Configure via /api/config/ai  (Anthropic API key)")
    print("🔔 Beep reminders:  POST /api/reminders/beep")
    print("⚡ n8n Webhook:     POST /api/webhook/n8n")
    print("📊 n8n Workflow:    GET  /api/n8n/workflow")
    app.run(host='0.0.0.0', port=5000, debug=True)