// server.js (Render에 배포될 Node.js Express 프록시)
// 목적: Render가 클라이언트 파일을 받아서 RunPod "Pod HTTP Proxy"로 그대로 전달

import express from "express";
import multer from "multer";
import axios from "axios";
import fs from "fs";
import FormData from "form-data";

const app = express();
const port = process.env.PORT || 3000;

// ✅ Pod 프록시 베이스 URL (예: https://<POD_ID>-8000.proxy.runpod.net)
const POD_BASE_URL = process.env.POD_BASE_URL;
if (!POD_BASE_URL) {
  console.error("❌ POD_BASE_URL env is missing. Example: https://<POD_ID>-8000.proxy.runpod.net");
}

// Multer: 업로드 파일을 임시 저장
const upload = multer({ dest: "/tmp/" });

// CORS (원하면 프론트 도메인으로 좁혀)
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// -------------------------------------------------------------
// ✅ 헬스체크: Render 자체
// -------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, mode: "render-proxy", pod: POD_BASE_URL || null });
});

// ✅ Pod 헬스체크 프록시 (FastAPI의 /ping 또는 /health로 연결)
app.get("/ping", async (req, res) => {
  try {
    const r = await axios.get(`${POD_BASE_URL}/ping`, { timeout: 10_000 });
    res.status(r.status).send(r.data);
  } catch (e) {
    // /ping이 없으면 /health로 한 번 더 시도
    try {
      const r2 = await axios.get(`${POD_BASE_URL}/health`, { timeout: 10_000 });
      res.status(r2.status).send(r2.data);
    } catch (e2) {
      res.status(502).json({
        error: "Pod ping/health failed",
        details: e2?.message || e?.message,
      });
    }
  }
});

// -------------------------------------------------------------
// ✅ 공통: 파일 하나를 Pod로 multipart로 전달하는 헬퍼
// -------------------------------------------------------------
async function forwardFileMultipart({ endpointPath, uploadedFile, extraFields = {} }) {
  const form = new FormData();

  // file field name은 FastAPI에서 UploadFile=File(...) 이므로 "file"로 맞춤
  form.append("file", fs.createReadStream(uploadedFile.path), uploadedFile.originalname);

  // 추가 Form 필드들
  for (const [k, v] of Object.entries(extraFields)) {
    form.append(k, String(v));
  }

  const headers = form.getHeaders();

  // axios로 전송 (responseType은 endpoint별로 지정)
  return { form, headers };
}

// -------------------------------------------------------------
// ✅ POST /transcribe  -> Pod의 /transcribe로 전달
// -------------------------------------------------------------
app.post("/transcribe", upload.single("file"), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) return res.status(400).send("No file uploaded.");

  try {
    const { form, headers } = await forwardFileMultipart({
      endpointPath: "/transcribe",
      uploadedFile,
    });

    const r = await axios.post(`${POD_BASE_URL}/transcribe`, form, {
      headers,
      responseType: "arraybuffer",
      timeout: 5 * 60 * 1000, // 5분 (필요시 조절)
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    res.setHeader("Content-Type", "audio/midi");
    res.status(r.status).send(r.data);
  } catch (e) {
    console.error("Pod Proxy /transcribe Error:", e?.message);
    res.status(500).json({ error: "Pod transcribe failed", details: e?.message });
  } finally {
    try {
      if (uploadedFile?.path) fs.unlinkSync(uploadedFile.path);
    } catch {}
  }
});

// -------------------------------------------------------------
// ✅ POST /midi-to-musicxml -> Pod의 /midi-to-musicxml로 전달
// -------------------------------------------------------------
app.post("/midi-to-musicxml", upload.single("file"), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) return res.status(400).send("No file uploaded.");

  try {
    const { form, headers } = await forwardFileMultipart({
      endpointPath: "/midi-to-musicxml",
      uploadedFile,
    });

    const r = await axios.post(`${POD_BASE_URL}/midi-to-musicxml`, form, {
      headers,
      responseType: "arraybuffer",
      timeout: 5 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    res.setHeader("Content-Type", "application/vnd.recordare.musicxml+xml");
    res.status(r.status).send(r.data);
  } catch (e) {
    console.error("Pod Proxy /midi-to-musicxml Error:", e?.message);
    res.status(500).json({ error: "Pod midi-to-musicxml failed", details: e?.message });
  } finally {
    try {
      if (uploadedFile?.path) fs.unlinkSync(uploadedFile.path);
    } catch {}
  }
});

// -------------------------------------------------------------
// ✅ POST /separate/piano -> Pod의 /separate/piano로 전달
// (Form 필드: has_vocals)
// -------------------------------------------------------------
app.post("/separate/piano", upload.single("file"), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) return res.status(400).send("No file uploaded.");

  const hasVocals = req.body?.has_vocals ?? "false";

  try {
    const { form, headers } = await forwardFileMultipart({
      endpointPath: "/separate/piano",
      uploadedFile,
      extraFields: { has_vocals: hasVocals },
    });

    const r = await axios.post(`${POD_BASE_URL}/separate/piano`, form, {
      headers,
      responseType: "arraybuffer",
      timeout: 10 * 60 * 1000, // 분리 오래 걸리면 늘려
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    res.setHeader("Content-Type", "audio/wav");
    res.status(r.status).send(r.data);
  } catch (e) {
    console.error("Pod Proxy /separate/piano Error:", e?.message);
    res.status(500).json({ error: "Pod separate piano failed", details: e?.message });
  } finally {
    try {
      if (uploadedFile?.path) fs.unlinkSync(uploadedFile.path);
    } catch {}
  }
});

// -------------------------------------------------------------
// ✅ POST /arrangement/midi -> Pod의 /arrangement/midi로 전달
// (Form 필드: keep_original)
// -------------------------------------------------------------
app.post("/arrangement/midi", upload.single("file"), async (req, res) => {
  const uploadedFile = req.file;
  if (!uploadedFile) return res.status(400).send("No file uploaded.");

  const keepOriginal = req.body?.keep_original ?? "true";

  try {
    const { form, headers } = await forwardFileMultipart({
      endpointPath: "/arrangement/midi",
      uploadedFile,
      extraFields: { keep_original: keepOriginal },
    });

    const r = await axios.post(`${POD_BASE_URL}/arrangement/midi`, form, {
      headers,
      responseType: "arraybuffer",
      timeout: 5 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    res.setHeader("Content-Type", "audio/midi");
    res.status(r.status).send(r.data);
  } catch (e) {
    console.error("Pod Proxy /arrangement/midi Error:", e?.message);
    res.status(500).json({ error: "Pod arrangement failed", details: e?.message });
  } finally {
    try {
      if (uploadedFile?.path) fs.unlinkSync(uploadedFile.path);
    } catch {}
  }
});

// 서버 시작
app.listen(port, () => {
  console.log(`Render Proxy Server running on port ${port}`);
  console.log(`POD_BASE_URL: ${POD_BASE_URL}`);
});
