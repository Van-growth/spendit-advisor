const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `당신은 스팬딧(Spendit) 경비관리 솔루션 전문가이자 세일즈 어드바이저입니다.`;

function extractText(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (['txt', 'csv', 'md'].includes(ext)) {
    return file.buffer.toString('utf-8').slice(0, 8000);
  }
  return `[${file.originalname} — ${(file.size / 1024).toFixed(1)}KB]`;
}

app.post('/api/analyze', upload.array('files', 10), async (req, res) => {
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
      model: 'claude-opus-4-5',
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

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages
    });
    res.json({ ok: true, text: msg.content[0].text });
  } catch (e) {
    console.error('chat error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ running on port ${PORT}`));
