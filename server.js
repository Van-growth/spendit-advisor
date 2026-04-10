const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const SYSTEM_PROMPT = `당신은 스팬딧(Spendit) 경비관리 솔루션 전문가이자 세일즈 어드바이저입니다.
고객사가 업로드한 자료만을 기반으로 분석하고 답변합니다.
업로드된 자료에 없는 내용은 절대 임의로 추가하지 않으며,
파악 불가한 항목은 반드시 "⚠ 확인 필요" 로 표시합니다.

## 스팬딧 핵심 기능
- 폴리시(Policy): 카테고리+승인체계+규정을 묶은 독립 정책 단위 (부서/팀/지점별)
- 카테고리 = 계정과목 (한도·증빙·참석자·메모·태그 필수 설정 가능)
- 태그 = ERP 관리항목 (프로젝트코드·거래처·CC 등, ERP 직접 연동 가능)
- 승인모드: 단일제출 / 단일승인 / 멀티선택승인 / 멀티지정승인
- Plan(플랜): 사전품의 기능. 예산 배정 → 실지출 → 후보고 연결
- 거리 지출: 출발지→도착지 입력 시 유종별 km당 금액 자동 계산
- 보고서 스케줄 자동제출: 특정 주기/시간에 자동 제출
- 매입세액 불공제: 카테고리별 설정 (해외결제·PG사 처리 핵심)
- 보고서 환율: 해외결제 건 지출일 기준 환율 자동 계산
- ERP 연동: 더존iU·SmartA·SAP·이카운트 업로드 양식 / 태그·거래처 직접 연동

## 스팬딧 11단계 세팅
1. 조직/사용자 권한 (CO/CA/PO/PA/Approver/일반)
2. 결제수단 (법인카드 연동방식, 개인결제 허용)
3. 지출 카테고리 (계정과목, CSV 대량 업로드)
4. 카테고리별 필수입력 (참석자·메모·태그·증빙 강제)
5. 금액 한도 (1회/일/월 누적, 영수증 첨부 최소금액)
6. 시간·예외 규정 (야근식대·주말·출장 예외)
7. 승인 정책 (금액별 전결, 다단계 승인, 자동승인)
8. 증빙 규정 (OCR, 필수첨부 카테고리)
9. 보고서 설정 (마감, 자동제출, 리마인더, Plan)
10. 가시성/수정권한 (팀장 조회, 승인후 수정제한)
11. Export/ERP 연동 (계정과목 매핑, VAT, 프로젝트코드)

## 답변 원칙
- 반드시 고객사가 업로드한 자료에서 파악된 내용만 반영
- 자료에 없는 내용은 절대 임의 생성 금지
- 파악 불가 시 반드시 "⚠ 확인 필요: [질문 제안]" 명시
- 실제 스팬딧 메뉴 경로 포함 (예: 폴리시 > 카테고리 > 설정)
- 한국어로 답변

## 스팬딧 공식 문서
세팅 가이드 작성 시 web_search로 https://docs.spendit.kr/ko/ 를 검색해서
실제 메뉴 경로와 설정 방법을 확인하고 안내하세요.`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'spendit2024';
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// ── data 폴더 생성 ──
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── 세션 저장소 ──
const sessions = new Map(); // clientId → { companyName, createdAt }

function sessionFile(clientId) {
  return path.join(DATA_DIR, `${clientId}.json`);
}

// sessions.json 전체 저장
function saveSessionsFile() {
  const obj = {};
  for (const [id, meta] of sessions.entries()) {
    obj[id] = meta;
  }
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
}

// ── 서버 시작 시 sessions.json 복원 ──
(function loadPersistedSessions() {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      for (const [id, meta] of Object.entries(obj)) {
        if (meta.companyName && meta.createdAt) {
          sessions.set(id, { companyName: meta.companyName, createdAt: meta.createdAt });
        }
      }
      console.log(`✅ ${sessions.size}개 세션 복원됨 (sessions.json)`);
      return;
    } catch (_) {}
  }
  // fallback: 기존 개별 json 파일에서 복원
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && f !== 'sessions.json');
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
      const clientId = f.replace('.json', '');
      const companyName = data.companyName || data.company;
      if (companyName && data.createdAt) {
        sessions.set(clientId, { companyName, createdAt: data.createdAt });
      }
    } catch (_) {}
  }
  if (sessions.size > 0) {
    saveSessionsFile(); // 마이그레이션: sessions.json 신규 생성
    console.log(`✅ ${sessions.size}개 세션 복원됨 (개별 파일 → sessions.json 마이그레이션)`);
  }
})();

function randomCode() {
  return Math.random().toString(36).slice(2, 8);
}

function slugify(name) {
  return name.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30);
}

// ── 세션 검증 미들웨어 ──
function requireSession(req, res, next) {
  const clientId = req.headers['x-client-id'];
  if (!clientId || !sessions.has(clientId)) {
    return res.status(401).json({ ok: false, error: '유효하지 않은 세션입니다.' });
  }
  next();
}

// ── 세션 생성 API ──
app.post('/api/create-session', (req, res) => {
  const pw = req.headers['x-admin-pw'] || req.body.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: '권한 없음' });

  const companyName = (req.body.company || 'client').trim();
  const clientId = `${slugify(companyName)}-${randomCode()}`;
  sessions.set(clientId, { companyName, createdAt: new Date().toISOString() });
  saveSessionsFile();
  res.json({ ok: true, clientId });
});

// ── 세션 목록 API ──
app.get('/api/sessions', (req, res) => {
  const pw = req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: '권한 없음' });

  const list = [...sessions.entries()].map(([id, v]) => ({ clientId: id, companyName: v.companyName, createdAt: v.createdAt }));
  res.json({ ok: true, sessions: list });
});

// ── 세션 회사명 조회 (인증 불필요) ──
app.get('/api/session-info/:clientId', (req, res) => {
  const { clientId } = req.params;
  const meta = sessions.get(clientId);
  if (!meta) return res.status(404).json({ ok: false, error: '세션 없음' });
  res.json({ ok: true, companyName: meta.companyName });
});

// ── 세션 데이터 조회 ──
app.get('/api/session/:clientId', (req, res) => {
  const { clientId } = req.params;
  if (!sessions.has(clientId)) return res.status(401).json({ ok: false, error: '유효하지 않은 세션' });

  const file = sessionFile(clientId);
  if (!fs.existsSync(file)) return res.json({ ok: true, data: null });

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const { drafts, threads, confirmed, customer } = raw;
    res.json({ ok: true, data: { drafts, threads, confirmed, customer } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 세션 데이터 저장 ──
app.post('/api/session/:clientId', requireSession, (req, res) => {
  const { clientId } = req.params;
  const { drafts, threads, confirmed, customer } = req.body;

  const file = sessionFile(clientId);
  let existing = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) {}
  }
  const updated = { ...existing, drafts, threads, confirmed, customer };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2));
  res.json({ ok: true });
});

// ── 관리자 페이지 ──
app.get('/admin', (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) {
    return res.status(403).send('<h2 style="font-family:sans-serif;padding:40px">403 Forbidden — 비밀번호가 필요합니다: /admin?pw=...</h2>');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── 정적 파일 (admin 라우트 이후) ──
app.use(express.static(path.join(__dirname, 'public')));

function extractText(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (['txt', 'csv', 'md'].includes(ext)) {
    return file.buffer.toString('utf-8').slice(0, 8000);
  }
  return `[${file.originalname} — ${(file.size / 1024).toFixed(1)}KB]`;
}

app.post('/api/analyze', requireSession, upload.array('files', 10), async (req, res) => {
  try {
    const pasteText = req.body.paste || '';
    const questions = JSON.parse(req.body.questions || '[]');
    let fileCtx = '';
    if (req.files) {
      fileCtx = req.files.map(f => `[${f.originalname}]\n${extractText(f)}`).join('\n\n');
    }
    const qList = questions.map(q => `[${q.id}] ${q.text}`).join('\n');
    const prompt = `다음은 고객사의 경비/비용 관련 자료입니다.\n\n=== 고객사 자료 ===\n${pasteText || '(텍스트 입력 없음)'}\n${fileCtx ? '\n=== 첨부 파일 ===\n' + fileCtx : ''}\n\n위 자료를 분석해서 아래 두 가지를 JSON으로만 응답해주세요. 마크다운 코드블록 없이 순수 JSON만.\n\n1. "customer": { "name": "회사명(없으면 미상)", "meta": "업종·규모·ERP 등 핵심 정보 2줄 이내" }\n2. "drafts": 각 질문 ID에 대한 초안 답변\n\n질문 목록:\n${qList}\n\n{\n  "customer": { "name": "...", "meta": "..." },\n  "drafts": {\n    "q1_1": "자료 기반 초안 답변. 없으면 ⚠ 확인 필요: [추천 내용]",\n    ...\n  }\n}`;
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    });
    let raw = msg.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ ok: true, data: parsed });
  } catch (e) {
    console.error('analyze error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/chat', requireSession, async (req, res) => {
  try {
    const { messages } = req.body;
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
        allowed_domains: ['docs.spendit.kr']
      }]
    });
    const reply = msg.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    res.json({ ok: true, text: reply });
  } catch (e) {
    console.error('chat error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── 루트: ?client= 없으면 /admin 으로 리다이렉트 ──
app.get('/', (req, res) => {
  if (!req.query.client) return res.redirect('/admin?pw=');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ running on port ${PORT}`));
