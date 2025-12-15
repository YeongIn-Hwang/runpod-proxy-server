// server.js (Render에 배포될 Node.js Express 애플리케이션)

import express from 'express';
import multer from 'multer';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary'; // Cloudinary SDK import
import fs from 'fs'; // 파일 시스템 모듈 (임시 파일 삭제용)

const app = express();
const port = process.env.PORT || 3000;

// Multer 설정: 클라이언트가 보낸 파일을 받아서 임시 디스크 경로에 저장합니다.
// RunPod에 보내기 전에 Cloudinary에 업로드해야 하므로 임시 저장이 필요합니다.
const upload = multer({ dest: '/tmp/' }); 

// 🚨 Cloudinary 설정: 환경 변수 사용 (Render Setting에서 등록한 3가지 키)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// RunPod 기본 설정 (환경 변수 사용)
const RUNPOD_BASE_URL = `https://api.runpod.ai/v2/${process.env.RUNPOD_ENDPOINT_ID}`;
const RUNPOD_HEADERS = {
    // 1단계에서 얻은 RunPod API 키를 사용합니다.
    'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}`,
    'Content-Type': 'application/json',
};

// CORS 설정 (프론트엔드와 통신 허용)
app.use(express.json());
app.use((req, res, next) => {
    // ⚠️ TODO: 배포 시에는 '*' 대신 고객님의 실제 프론트엔드 URL로 변경하는 것이 보안상 안전합니다.
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});


// -------------------------------------------------------------
// 🛠️ 헬퍼 함수: RunPod 비동기 작업 폴링 로직 (작업이 끝날 때까지 3초마다 상태 확인)
// 
// -------------------------------------------------------------
async function pollRunPodJob(jobId) {
    let status = 'IN_PROGRESS';

    // 3초마다 상태 확인을 최대 30번 (총 90초)까지 시도
    for (let i = 0; i < 70; i++) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3초 대기

        const statusResponse = await axios.get(`${RUNPOD_BASE_URL}/status/${jobId}`, { headers: RUNPOD_HEADERS });
        status = statusResponse.data.status;
        const output = statusResponse.data.output;

        if (status === 'COMPLETED') {
            return output; // 성공 시 결과 반환
        } else if (status === 'FAILED') {
            throw new Error(`RunPod job failed. Details: ${JSON.stringify(output)}`);
        }
        // IN_PROGRESS 상태면 계속 루프
    }
    throw new Error('RunPod job timed out after 90 seconds.'); // 시간 초과
}


// -------------------------------------------------------------
// 📤 POST /transcribe 라우트 (오디오 -> MIDI 변환 요청 처리)
// -------------------------------------------------------------
app.post('/transcribe', upload.single('file'), async (req, res) => {
    const uploadedFile = req.file;
    if (!uploadedFile) {
        return res.status(400).send('No file uploaded.');
    }

    let publicFileUrl = null;

    try {
        // 1. Cloudinary에 파일 업로드 및 퍼블릭 URL 생성
        console.log(`Uploading file: ${uploadedFile.originalname} to Cloudinary...`);
        const uploadResult = await cloudinary.uploader.upload(uploadedFile.path, {
            resource_type: "auto", // 오디오/비디오 등 자동 감지
            folder: "runpod_inputs" // 파일을 저장할 폴더 이름
        });
        publicFileUrl = uploadResult.secure_url; 
        console.log(`Cloudinary URL: ${publicFileUrl}`);

        // 2. RunPod 작업 시작 (POST /run)
        const runResponse = await axios.post(`${RUNPOD_BASE_URL}/run`, {
            input: {
                // RunPod 모델이 기대하는 Input key는 'audio_file_url'입니다.
                audio_file_url: publicFileUrl,
            }
        }, { headers: RUNPOD_HEADERS });

        const jobId = runResponse.data.id;
        if (!jobId) {
            throw new Error("Failed to get Job ID from RunPod.");
        }
        console.log(`RunPod Job ID: ${jobId}. Polling for status...`);

        // 3. RunPod 작업 완료 폴링 (결과 받을 때까지 대기)
        const output = await pollRunPodJob(jobId);
        console.log("RunPod Job COMPLETED.");

        // 4. 결과 파일 URL 추출 및 다운로드
        // RunPod 모델의 Output key가 'midi_file_url'이라고 가정합니다.
        const midiUrl = output.midi_file_url; 
        if (!midiUrl) {
            throw new Error("RunPod completed but no MIDI URL found in output.");
        }

        console.log(`Downloading MIDI from: ${midiUrl}`);
        const midiResponse = await axios.get(midiUrl, { responseType: 'arraybuffer' });

        // 5. 클라이언트에게 응답 반환
        res.setHeader('Content-Type', 'audio/midi'); // MIDI 파일 형식으로 응답 헤더 설정
        res.status(200).send(midiResponse.data);

    } catch (error) {
        console.error("RunPod Proxy Error:", error.message);
        // 오류 상세 정보를 클라이언트에 반환
        res.status(500).json({ 
            error: "AI 처리 중 오류가 발생했습니다.", 
            details: error.message 
        });
    } finally {
        // 6. 정리 작업: 서버 임시 파일 삭제
        // Render 서버의 디스크 공간 관리를 위해 임시 파일을 삭제합니다.
        try {
            if (uploadedFile && uploadedFile.path) {
                fs.unlinkSync(uploadedFile.path); 
                console.log(`Deleted temporary file: ${uploadedFile.path}`);
            }
            // ⚠️ Cloudinary에 업로드한 파일은 필요에 따라 Cloudinary API를 사용해 삭제할 수 있습니다.
        } catch (cleanupError) {
            console.error("Cleanup failed:", cleanupError);
        }
    }
});

// 서버 시작
app.listen(port, () => {
    console.log(`Render Proxy Server running on port ${port}`);
    console.log(`Base URL: ${RUNPOD_BASE_URL}`);
});